import OpenAI from "openai";
import type { Stream } from "openai/core/streaming.mjs";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
  Api,
  AssistantMessage,
  Model,
  OpenAIResponsesCompat,
  RequestHeaders,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  TranscriptContext,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { retryRequest } from "../utils/request-retry.ts";
import { resolveCacheRetention } from "../utils/cache-retention.ts";
import { getDeclaredTools, resolveTranscript } from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { buildParams } from "./openai-responses-request.ts";
import { processResponsesStream } from "./openai-responses-stream.ts";

/**
 * 合并模型兼容配置与默认值，得到完整的端点兼容能力。
 * @param model - 目标模型。
 * @returns 所有字段均已填充的兼容配置；未指定会话亲和格式时，openrouter.ai 地址使用 `openrouter`，其余使用 `openai`。
 */
function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
  return {
    supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
    supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
    sessionAffinityFormat:
      model.compat?.sessionAffinityFormat ??
      (model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai"),
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
    supportsStrictMode: model.compat?.supportsStrictMode ?? false,
    supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
    supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
    supportsToolSearch: model.compat?.supportsToolSearch ?? false,
    supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
    supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
  };
}

// OpenAI Responses 专属选项。
export interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * 发起 OpenAI Responses 请求，并将响应转换为助手消息事件流。
 * @param model - 请求的目标模型及端点兼容配置。
 * @param context - 待发送的会话上下文。
 * @param options - API 密钥、请求参数和生命周期回调。
 * @returns 立即返回的助手消息事件流，响应内容随后异步写入。
 * @remarks 会发起网络请求；请求和响应处理中的错误通过错误事件报告。
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
  model: Model<"openai-responses">,
  context: TranscriptContext,
  options: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();
  const compat = getCompat(model);
  const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);

  // 启动异步处理。
  (async (): Promise<void> => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api as Api,
      baseUrl: model.baseUrl,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      // 创建 OpenAI 客户端。
      const apiKey = options?.apiKey;
      if (typeof apiKey !== "string" || !apiKey.trim()) {
        throw new Error("apiKey must be a non-empty string");
      }
      const cacheRetention = resolveCacheRetention(options.cacheRetention, options.env);
      const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
      const grammarToolInputProperties = createGrammarToolInputProperties(
        getDeclaredTools(normalizedContext.messages),
        compat.supportsOpenAIGrammarTools,
      );
      const client = createClient(
        model,
        apiKey,
        compat,
        options.headers,
        options.fetch,
        cacheSessionId,
      );
      let params = buildParams(
        model,
        normalizedContext,
        options,
        compat,
        grammarToolInputProperties,
      );
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as ResponseCreateParamsStreaming;
      }
      const requestOptions = {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        maxRetries: 0,
      };
      const { data: openaiStream, response } = await retryRequest(
        (): Promise<{
          data: Stream<OpenAI.Responses.ResponseStreamEvent>;
          response: Response;
          request_id: string | null;
        }> => client.responses.create(params, requestOptions).withResponse(),
        {
          maxRetries: options?.maxRetries,
          maxRetryDelayMs: options?.maxRetryDelayMs,
          signal: options?.signal,
        },
      );
      await options?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );
      stream.push({ type: "start", partial: output });

      await processResponsesStream(openaiStream, output, stream, model, {
        onStreamEvent: options?.onStreamEvent,
        onProviderStreamEvent: options?.onProviderStreamEvent,
        grammarToolInputProperties,
        serviceTier: options?.serviceTier,
      });

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "pending") {
        throw new Error("OpenAI Responses stream ended without a stop reason");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // 流式临时缓冲区仅用于解析，不得持久化。
        delete (block as { partialJson?: string }).partialJson;
        delete (block as { customInput?: unknown }).customInput;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatProviderError(
        normalizeProviderError(error),
        "OpenAI Responses API error",
      );
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

/**
 * 使用通用简化选项发起 OpenAI Responses 流式请求。
 * @param model - 请求的目标模型。
 * @param context - 待发送的会话上下文。
 * @param options - 通用流式选项，推理等级会按模型能力限制。
 * @returns 立即返回的助手消息事件流，响应内容随后异步写入。
 * @remarks 推理等级限制后为 `off` 时不设置 reasoningEffort；其余行为同 {@link stream}。
 */
export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
  model: Model<"openai-responses">,
  context: TranscriptContext,
  options: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const base = {
    ...buildBaseOptions(model, context, options),
    toolChoice: options?.toolChoice,
  } satisfies OpenAIResponsesOptions;
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

  return stream(model, context, {
    ...base,
    reasoningEffort,
  } satisfies OpenAIResponsesOptions);
};

/**
 * 创建 OpenAI SDK 客户端，并合并默认、模型、会话亲和与调用方请求头。
 * @param model - 提供基础地址和模型级请求头的目标模型。
 * @param apiKey - 用于 Bearer 鉴权的 API 密钥。
 * @param compat - 决定会话亲和请求头格式的兼容配置。
 * @param optionsHeaders - 调用方请求头，最后合并以覆盖默认值。
 * @param fetch - 自定义 fetch 实现。
 * @param sessionId - 会话标识；提供时按端点格式写入会话亲和请求头。
 * @returns 配置完成的 OpenAI 客户端。
 * @remarks 会清除组织、项目及 `x-api-key`/`api-key` 请求头，并强制设置 authorization。
 */
function createClient(
  model: Model<"openai-responses">,
  apiKey: string,
  compat: Required<OpenAIResponsesCompat>,
  optionsHeaders?: RequestHeaders,
  fetch?: typeof globalThis.fetch,
  sessionId?: string,
): OpenAI {
  const headers: RequestHeaders = {
    "User-Agent": getPiUserAgent(),
    "OpenAI-Organization": null,
    "OpenAI-Project": null,
    ...model.headers,
  };

  if (sessionId) {
    if (compat.sessionAffinityFormat === "openrouter") {
      headers["x-session-id"] = sessionId;
    } else {
      if (compat.sessionAffinityFormat === "openai") {
        headers.session_id = sessionId;
      }
      headers["x-client-request-id"] = sessionId;
    }
  }

  // 最后合并 options 请求头，使其能够覆盖默认值。
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  return new OpenAI({
    apiKey,
    adminAPIKey: null,
    organization: null,
    project: null,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    fetch,
    defaultHeaders: {
      ...headers,
      authorization: `Bearer ${apiKey}`,
      "x-api-key": null,
      "api-key": null,
    },
  });
}

import OpenAI from "openai";
import type { Stream } from "openai/core/streaming.mjs";
import { clampThinkingLevel } from "../models.ts";
import type {
  AssistantMessage,
  Model,
  RequestHeaders,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingBudgets,
  ThinkingContent,
  ToolCall,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { retryRequest } from "../utils/request-retry.ts";
import { resolveCacheRetention } from "../utils/cache-retention.ts";
import {
  getDeclaredTools,
  resolveTranscript,
  type TranscriptContext,
} from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { buildParams, type ResolvedOpenAICompletionsCompat } from "./openai-completions-request.ts";
import { processCompletionsStream } from "./openai-completions-stream.ts";

export interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * 显式兼容预算字段或 { "$var": "thinking.budget" } 使用的 token 预算。
   */
  thinkingBudgets?: ThinkingBudgets;
}

/**
 * 通过 OpenAI Chat Completions 兼容接口发起流式请求，并转换为统一的助手消息事件流。
 * @param model - 请求使用的模型，其 `baseUrl` 与 `compat` 决定端点兼容行为。
 * @param context - 待发送的会话上下文。
 * @param options - 请求选项，必须包含非空 `apiKey`。
 * @returns 立即返回的助手消息事件流；后台依次推送 start、各内容块的 start/delta/end 事件，最后推送 done 或 error。
 * @remarks 请求失败、缺少 `apiKey`、被中止或流结束时缺少 finish_reason 等错误不会抛给调用方，而是以 error 事件推送并结束流；中止时 `stopReason` 为 `aborted`。
 */
export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
  model: Model<"openai-completions">,
  context: TranscriptContext,
  options: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();
  const compat = getCompat(model);
  const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);

  (async (): Promise<void> => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
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
      const apiKey = options?.apiKey;
      if (!apiKey?.trim()) {
        throw new Error("apiKey is required");
      }
      const grammarToolInputProperties = createGrammarToolInputProperties(
        getDeclaredTools(normalizedContext.messages),
        compat.supportsOpenAIGrammarTools,
      );
      const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
      const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
      const client = createClient(
        model,
        apiKey,
        compat,
        options?.headers,
        options?.fetch,
        cacheSessionId,
      );
      let params = buildParams(
        model,
        normalizedContext,
        options,
        compat,
        cacheRetention,
        grammarToolInputProperties,
      );
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
      }
      const requestOptions = {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        maxRetries: 0,
      };
      const { data: openaiStream, response } = await retryRequest(
        (): Promise<{
          data: Stream<OpenAI.ChatCompletionChunk>;
          response: Response;
          request_id: string | null;
        }> => client.chat.completions.create(params, requestOptions).withResponse(),
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

      const { hasFinishReason } = await processCompletionsStream(
        openaiStream,
        output,
        model,
        grammarToolInputProperties,
        stream,
        (chunk: unknown, eventModel: Model): void | Promise<void> => {
          return (options?.onStreamEvent ?? options?.onProviderStreamEvent)?.(chunk, eventModel);
        },
      );
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted") {
        throw new Error("Request was aborted");
      }
      if (!hasFinishReason && !compat.supportsFinishReason) {
        output.stopReason = output.content.some(
          (block: TextContent | ThinkingContent | ToolCall): block is ToolCall =>
            block.type === "toolCall",
        )
          ? "toolUse"
          : "stop";
      }
      if (output.stopReason === "error") {
        throw new Error(output.errorMessage || "Endpoint returned an error stop reason");
      }
      if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
        throw new Error("Stream ended without finish_reason");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // 流式临时缓冲区仅用于解析，不得持久化。
        delete (block as { partialArgs?: string }).partialArgs;
        delete (block as { customInput?: unknown }).customInput;
        delete (block as { streamIndex?: number }).streamIndex;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatProviderError(normalizeProviderError(error));
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

/**
 * 使用简化选项发起 OpenAI Chat Completions 兼容流式请求。
 * @param model - 请求使用的模型。
 * @param context - 待发送的会话上下文。
 * @param options - 简化流式选项，`reasoning` 会按模型能力收敛为推理强度。
 * @returns 与 {@link stream} 相同的助手消息事件流。
 * @remarks 收敛后的推理等级为 `off` 时不发送推理强度；错误处理语义与 {@link stream} 一致。
 */
export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
  model: Model<"openai-completions">,
  context: TranscriptContext,
  options: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const base = {
    ...buildBaseOptions(model, context, options),
    toolChoice: options?.toolChoice,
  } satisfies OpenAICompletionsOptions;
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

  return stream(model, context, {
    ...base,
    reasoningEffort,
    thinkingBudgets: options?.thinkingBudgets,
  } satisfies OpenAICompletionsOptions);
};

/**
 * 创建针对模型端点配置好请求头的 OpenAI 客户端。
 * @param model - 提供 `baseUrl` 与默认请求头的模型。
 * @param apiKey - 用于 Bearer 鉴权的 API 密钥。
 * @param compat - 端点兼容配置，决定是否及如何发送会话亲和请求头。
 * @param optionsHeaders - 调用方传入的请求头，最后合并以覆盖默认值。
 * @param fetch - 自定义 fetch 实现；未提供时使用 SDK 默认实现。
 * @param sessionId - 会话 ID，用于会话亲和请求头；为空时不发送。
 * @returns 已配置的 OpenAI 客户端实例。
 * @remarks 会清除 SDK 默认的组织、项目请求头以及 `x-api-key`、`api-key` 请求头，并强制使用 `authorization` 头鉴权。
 */
function createClient(
  model: Model<"openai-completions">,
  apiKey: string,
  compat: ResolvedOpenAICompletionsCompat,
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

  if (sessionId && compat.sendSessionAffinityHeaders) {
    if (compat.sessionAffinityFormat === "openrouter") {
      headers["x-session-id"] = sessionId;
    } else {
      if (compat.sessionAffinityFormat === "openai") {
        headers.session_id = sessionId;
      }
      headers["x-client-request-id"] = sessionId;
      headers["x-session-affinity"] = sessionId;
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

/**
 * 根据模型 `baseUrl` 与模型 ID 推断端点的默认兼容配置。
 * @param model - 待检测的模型。
 * @returns 依据已知服务商（如 Z.ai、DeepSeek、OpenRouter、Together 等）域名推断出的完整兼容配置。
 */
function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
  const baseUrl = model.baseUrl.toLowerCase();
  const isZai = baseUrl.includes("api.z.ai") || baseUrl.includes("open.bigmodel.cn");
  const isTogether = baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
  const isMoonshot = baseUrl.includes("api.moonshot.");
  const isOpenRouter = baseUrl.includes("openrouter.ai");
  const isCloudflareWorkersAI = baseUrl.includes("api.cloudflare.com");
  const isCloudflareAiGateway = baseUrl.includes("gateway.ai.cloudflare.com");
  const isNvidia = baseUrl.includes("integrate.api.nvidia.com");
  const isAntLing = baseUrl.includes("api.ant-ling.com");
  const isCerebras = baseUrl.includes("cerebras.ai");
  const isDeepSeek = baseUrl.includes("deepseek.com");
  const isGrok = baseUrl.includes("api.x.ai");
  const isOpenRouterDeveloperRoleModel =
    isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
  const isNonStandard =
    isNvidia ||
    isCerebras ||
    isGrok ||
    isTogether ||
    baseUrl.includes("chutes.ai") ||
    isDeepSeek ||
    isZai ||
    isMoonshot ||
    baseUrl.includes("opencode.ai") ||
    isCloudflareWorkersAI ||
    isCloudflareAiGateway ||
    isAntLing;
  const useMaxTokens =
    baseUrl.includes("chutes.ai") ||
    isDeepSeek ||
    isMoonshot ||
    isCloudflareAiGateway ||
    isTogether ||
    isNvidia ||
    isAntLing ||
    isZai;
  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
    supportsReasoningEffort:
      !isGrok &&
      !isZai &&
      !isMoonshot &&
      !isTogether &&
      !isCloudflareAiGateway &&
      !isNvidia &&
      !isAntLing,
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: isDeepSeek,
    thinkingFormat: isDeepSeek
      ? "deepseek"
      : isZai
        ? "zai"
        : isTogether
          ? "together"
          : isAntLing
            ? "ant-ling"
            : isOpenRouter
              ? "openrouter"
              : "openai",
    openRouterRouting: {},
    vercelGatewayRouting: undefined,
    chatTemplateKwargs: {},
    chatTemplateArgs: {},
    zaiToolStream: false,
    supportsThinkingTokenBudget: false,
    thinkingTokenBudgetField: undefined,
    supportsStrictMode: false,
    supportsOpenAIGrammarTools: false,
    supportsMidConvoSystemMessages: false,
    supportsMidConvoToolAdditions: false,
    cacheControlFormat: isOpenRouter && model.id.startsWith("anthropic/") ? "anthropic" : undefined,
    sendSessionAffinityHeaders: isOpenRouter,
    sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
    supportsLongCacheRetention: !(
      isTogether ||
      isCloudflareWorkersAI ||
      isCloudflareAiGateway ||
      isNvidia ||
      isAntLing
    ),
    vllmPriority: undefined,
  };
}

/**
 * 将模型显式声明的兼容配置合并到按 URL 推断的默认配置之上。
 * @param model - 待解析的模型。
 * @returns 合并后的兼容配置；模型未声明 `compat` 时返回推断的默认配置。
 * @remarks 显式配置中值为 undefined 的模板参数与路由字段会回退为默认值。
 */
function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
  const detected = detectCompat(model);
  const compat = model.compat;
  if (!compat) {
    return detected;
  }
  return {
    ...detected,
    ...compat,
    chatTemplateKwargs: compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
    chatTemplateArgs: compat.chatTemplateArgs ?? detected.chatTemplateArgs,
    openRouterRouting: compat.openRouterRouting ?? detected.openRouterRouting,
    vercelGatewayRouting: compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
  };
}

import Anthropic, { type APIRequest, type MiddlewareNext } from "@anthropic-ai/sdk";
import type {
  BetaInputTransformation,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type {
  Api,
  AssistantMessage,
  Model,
  RequestHeaders,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
} from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { retryRequest } from "../utils/request-retry.ts";
import { resolveCacheRetention } from "../utils/cache-retention.ts";
import { resolveTranscript, type TranscriptContext } from "../utils/transcript.ts";
import {
  adjustMaxTokensForThinking,
  buildBaseOptions,
  clampMaxTokensToContext,
} from "./simple-options.ts";
import { buildParams, getAnthropicCompat, requireMaxTokens } from "./anthropic-messages-request.ts";
import { processAnthropicStream } from "./anthropic-messages-stream.ts";

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

export interface AnthropicOptions extends StreamOptions {
  /**
   * 是否启用扩展思考。自适应思考模型自行决定思考时机与预算；旧模型使用 thinkingBudgetTokens 指定预算。默认 undefined：除非 streamSimple() 将简化推理级别映射到此选项，或调用方显式设置，否则不发送思考配置。
   */
  thinkingEnabled?: boolean;
  /**
   * 旧模型的扩展思考 token 预算，自适应思考模型忽略此字段。thinkingEnabled 为 true 且未指定预算时，默认 1024。
   */
  thinkingBudgetTokens?: number;
  /**
   * 自适应思考模型的 effort 级别，旧模型忽略此字段。max 表示不受约束地持续思考（仅 Opus 4.6）；xhigh 为最高推理级别（Opus 4.7+、Fable 5）；high 始终深度思考；medium 适度思考，简单问题可跳过；low 尽量减少思考，简单任务跳过。默认省略，除非 streamSimple() 将简化推理级别映射到此选项。
   */
  effort?: AnthropicEffort;
  /**
   * 控制响应中的思考内容：summarized 返回思考摘要；omitted 返回空思考字段，但仍保留加密签名以支持多轮连续性，适用于不展示思考且希望更快收到首个文本 token 的界面。Anthropic 对 Claude Opus 4.7 与 Claude Mythos Preview 的默认值为 omitted；本实现启用思考时默认 summarized，以保持与旧 Claude 4 模型一致，调用方可显式设置 omitted。
   */
  thinkingDisplay?: AnthropicThinkingDisplay;
  /**
   * 是否为非自适应思考模型请求交错思考测试请求头，默认 true。自适应思考模型内建交错思考，无论此设置为何值均不发送该请求头。
   */
  interleavedThinking?: boolean;
  /**
   * Anthropic 工具选择策略：字符串映射到内建选项，{ type: "tool", name } 强制使用指定工具。默认省略，采用 Anthropic 默认行为（当前等价于 auto）。
   */
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
}

/**
 * 调用 Anthropic Messages 流式接口，并将响应转换为统一的助手消息事件流。
 * @param model - Anthropic Messages 模型配置。
 * @param context - 会话上下文，会按模型是否支持会话中系统消息进行规范化。
 * @param options - 请求选项，必须包含非空的 apiKey。
 * @returns 立即返回的助手消息事件流；请求在后台异步执行，依次推送 start、内容增量与结束事件，最后以 done 或 error 事件结束。
 * @remarks 错误不会以异常形式抛出：缺少 apiKey、请求失败、流中断、未返回停止原因、停止原因为错误或中止等情况均通过 error 事件报告，信号中止时 stopReason 为 "aborted"。
 * 会依次调用 onPayload（可替换请求参数）、onResponse 与 onStreamEvent/onProviderStreamEvent 回调；存在服务端输入变换时追加诊断信息。
 */
export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
  model: Model<"anthropic-messages">,
  context: TranscriptContext,
  options: AnthropicOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();
  const normalizedContext = resolveTranscript(
    context,
    getAnthropicCompat(model).supportsMidConvoSystemMessages,
  );

  (async (): Promise<void> => {
    const thinkingEffort = model.compat?.supportsMidConvoEffort
      ? (options?.effort ?? "high")
      : undefined;
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api as Api,
      baseUrl: model.baseUrl,
      model: model.id,
      ...(thinkingEffort === undefined ? {} : { thinkingEffort }),
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
      if (typeof options?.apiKey !== "string" || options.apiKey.trim().length === 0) {
        throw new Error("An explicit apiKey is required");
      }
      const cacheRetention = resolveCacheRetention(options.cacheRetention, options.env);
      const cacheSessionId = cacheRetention === "none" ? undefined : options.sessionId;
      const client = createClient(
        model,
        options.apiKey,
        options.headers,
        options.fetch,
        cacheSessionId,
      );
      let params = buildParams(model, normalizedContext, { ...options, cacheRetention });
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = { ...(nextParams as MessageCreateParamsStreaming), stream: true };
      }
      const requestOptions = {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        maxRetries: 0,
      };
      const response = await retryRequest(
        (): Promise<Response> => client.beta.messages.create(params, requestOptions).asResponse(),
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

      const { inputTransformations } = await processAnthropicStream(
        response,
        model,
        output,
        stream,
        options?.signal,
        (event: unknown, eventModel: Model): void | Promise<void> => {
          return (options?.onStreamEvent ?? options?.onProviderStreamEvent)?.(event, eventModel);
        },
      );

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "pending") {
        throw new Error("Anthropic stream ended without a stop reason");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }
      if (inputTransformations && inputTransformations.length > 0) {
        appendAssistantMessageDiagnostic(output, {
          type: "anthropic_input_transformations",
          timestamp: Date.now(),
          details: {
            transformations: inputTransformations.map(
              (
                transformation: BetaInputTransformation,
              ): {
                type: "thinking_dropped" | "thinking_mismatch_allowed";
                path: string;
                reason:
                  | "end_user_binding_mismatch"
                  | "model_binding_mismatch"
                  | "organization_binding_mismatch"
                  | "prefix_binding_mismatch";
              } => ({
                type: transformation.type ?? undefined,
                path: transformation.path ?? undefined,
                reason: transformation.reason ?? undefined,
              }),
            ),
          },
        });
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // partialJson 仅用作流式解析的临时缓冲区，不得持久化。
        delete (block as { partialJson?: string }).partialJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

/**
 * 将通用推理级别映射为自适应思考模型的 Anthropic effort 级别。
 * @param model - 目标模型，优先使用其 thinkingLevelMap 中的字符串映射。
 * @param level - 通用推理级别。
 * @returns 映射后的 effort；minimal/low 映射为 "low"，medium 为 "medium"，high 及其他取值为 "high"。
 * @remarks effort "max" 适用于所有自适应思考 Claude 模型，原生 "xhigh" 仅 Opus 4.7/4.8、Sonnet 5 和 Fable 5 支持。
 */
function mapThinkingLevelToEffort(
  model: Model<"anthropic-messages">,
  level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
  const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
  if (typeof mapped === "string") {
    return mapped as AnthropicEffort;
  }

  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return "high";
  }
}

/**
 * 使用通用简化选项调用 Anthropic Messages 流式接口，自动将推理级别转换为思考配置。
 * @param model - Anthropic Messages 模型配置。
 * @param context - 会话上下文。
 * @param options - 简化流式选项，reasoning 决定是否及如何启用思考。
 * @returns 与 {@link stream} 相同的助手消息事件流。
 * @throws 使用预算思考且模型与选项都未提供 maxTokens 时，同步抛出 maxTokens 缺失错误。
 * @remarks 未指定 reasoning 或模型不支持推理时关闭思考；强制自适应思考的模型使用 effort；其他模型使用预算思考，
 * 会将 maxTokens 限制在上下文窗口内，并将思考预算限制为不超过 maxTokens - 1024（最小为 0）。
 */
export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
  model: Model<"anthropic-messages">,
  context: TranscriptContext,
  options: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const base = {
    ...buildBaseOptions(model, context, options),
    toolChoice: options?.toolChoice,
  } satisfies AnthropicOptions;
  if (!options?.reasoning || model.reasoning === false) {
    return stream(model, context, {
      ...base,
      thinkingEnabled: false,
    } satisfies AnthropicOptions);
  }

  // 自适应思考模型使用 effort 级别；旧模型使用 token 预算。
  if (model.compat?.forceAdaptiveThinking === true) {
    const effort = mapThinkingLevelToEffort(model, options.reasoning);
    return stream(model, context, {
      ...base,
      thinkingEnabled: true,
      effort,
    } satisfies AnthropicOptions);
  }

  // undefined 表示调用方未限制输出，由辅助函数采用模型上限。不能在此转换为 0，否则思考预算会占满 max_tokens。
  const adjusted = adjustMaxTokensForThinking(
    base.maxTokens,
    model.maxTokens ?? requireMaxTokens(model, options),
    options.reasoning,
    options.thinkingBudgets,
  );

  const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
  const maxThinkingBudget = Math.max(0, maxTokens - 1024);
  const thinkingBudgetTokens = Math.min(adjusted.thinkingBudget, maxThinkingBudget);

  return stream(model, context, {
    ...base,
    maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens,
  } satisfies AnthropicOptions);
};

/**
 * 创建用于当前请求的 Anthropic SDK 客户端。
 * @param model - 目标模型，提供 baseUrl、默认请求头与兼容性配置。
 * @param apiKey - 请求使用的 API key，通过中间件强制写入 x-api-key。
 * @param optionsHeaders - 请求级附加请求头，优先级高于模型请求头。
 * @param fetch - 可选的自定义 fetch 实现。
 * @param sessionId - 会话 ID；提供且模型启用会话亲和头时，写入 x-session-id（openrouter 格式）或 x-session-affinity。
 * @returns 配置完成的 Anthropic 客户端。
 * @remarks 中间件会删除 authorization 和 api-key 请求头，避免 SDK 合并的环境变量凭据覆盖显式 apiKey。
 */
function createClient(
  model: Model<"anthropic-messages">,
  apiKey: string,
  optionsHeaders?: RequestHeaders,
  fetch?: typeof globalThis.fetch,
  sessionId?: string,
): Anthropic {
  const compat = getAnthropicCompat(model);
  const sessionAffinityHeaders: RequestHeaders = {};
  if (sessionId && compat.sendSessionAffinityHeaders) {
    const header =
      compat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity";
    sessionAffinityHeaders[header] = sessionId;
  }
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    fetch,
    // SDK 在执行中间件前合并环境请求头；合并后再强制应用本次请求的密钥。
    middleware: [
      (request: APIRequest, next: MiddlewareNext): Promise<Response> => {
        request.headers.set("x-api-key", apiKey);
        request.headers.delete("authorization");
        request.headers.delete("api-key");
        return next(request);
      },
    ],
    defaultHeaders: {
      "User-Agent": getPiUserAgent(),
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      ...sessionAffinityHeaders,
      ...model.headers,
      ...optionsHeaders,
    },
  });
}

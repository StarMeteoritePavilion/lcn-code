import * as anthropic from "./api/anthropic-messages.ts";
import * as completions from "./api/openai-completions.ts";
import * as responses from "./api/openai-responses.ts";
import type {
  Api,
  ApiStreamOptions,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
} from "./types.ts";
import { AssistantMessageEventStream } from "./utils/event-stream.ts";
import { normalizeContext } from "./utils/transcript.ts";

const PROTOCOLS = {
  "anthropic-messages": anthropic,
  "openai-completions": completions,
  "openai-responses": responses,
};

/**
 * 校验模型与选项后，将请求分发到对应 API 协议实现的流式方法。
 * @param model - 目标模型，需包含受支持的 api、非空 id 与 baseUrl。
 * @param context - 对话上下文，分发前会经过 normalizeContext 规范化。
 * @param options - 流式选项，必须包含非空 apiKey。
 * @param method - 要调用的协议方法名。
 * @returns 助手消息事件流；校验失败或同步抛出异常时，返回仅包含一个 error 事件的已结束流。
 * @remarks 不会同步抛出异常；信号已中断时错误事件的 reason 为 aborted。
 */
function dispatch<TApi extends Api, TOptions extends StreamOptions>(
  model: Model<TApi>,
  context: Context,
  options: TOptions,
  method: "stream" | "streamSimple",
): AssistantMessageEventStream {
  try {
    if (!Object.hasOwn(PROTOCOLS, model.api)) {
      throw new Error(`Unsupported API: ${model.api}`);
    }
    if (typeof model.id !== "string" || !model.id.trim()) {
      throw new Error("Model id is required");
    }
    if (typeof model.baseUrl !== "string" || !model.baseUrl.trim()) {
      throw new Error("baseUrl is required");
    }
    if (typeof options?.apiKey !== "string" || !options.apiKey.trim()) {
      throw new Error("A non-empty apiKey is required");
    }
    options.signal?.throwIfAborted();
    const call = PROTOCOLS[model.api][method] as StreamFunction<TApi, TOptions>;
    return call(model, normalizeContext(context), options);
  } catch (error) {
    const stopReason = options?.signal?.aborted ? "aborted" : "error";
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      baseUrl: model.baseUrl,
      model: model.id,
      content: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    const result = new AssistantMessageEventStream();
    result.push({ type: "error", reason: stopReason, error: message });
    result.end(message);
    return result;
  }
}

/**
 * 使用协议原生选项向模型发起流式请求。
 * @param model - 目标模型。
 * @param context - 对话上下文。
 * @param options - 与模型 API 对应的流式选项，必须包含非空 apiKey。
 * @returns 助手消息事件流；参数校验失败时返回仅包含 error 事件的已结束流。
 */
export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options: ApiStreamOptions<TApi>,
): AssistantMessageEventStream {
  return dispatch(model, context, options, "stream");
}

/**
 * 使用协议原生选项向模型发起请求，并等待最终助手消息。
 * @param model - 目标模型。
 * @param context - 对话上下文。
 * @param options - 与模型 API 对应的流式选项，必须包含非空 apiKey。
 * @returns 兑现为最终助手消息；请求失败时消息的 stopReason 为 error 或 aborted，而不是拒绝。
 */
export function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options: ApiStreamOptions<TApi>,
): Promise<AssistantMessage> {
  return stream(model, context, options).result();
}

/**
 * 使用跨协议的简化选项向模型发起流式请求。
 * @param model - 目标模型。
 * @param context - 对话上下文。
 * @param options - 简化流式选项（如 reasoning），必须包含非空 apiKey。
 * @returns 助手消息事件流；参数校验失败时返回仅包含 error 事件的已结束流。
 */
export function streamSimple(
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
): AssistantMessageEventStream {
  return dispatch(model, context, options, "streamSimple");
}

/**
 * 使用跨协议的简化选项向模型发起请求，并等待最终助手消息。
 * @param model - 目标模型。
 * @param context - 对话上下文。
 * @param options - 简化流式选项（如 reasoning），必须包含非空 apiKey。
 * @returns 兑现为最终助手消息；请求失败时消息的 stopReason 为 error 或 aborted，而不是拒绝。
 */
export function completeSimple(
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
): Promise<AssistantMessage> {
  return streamSimple(model, context, options).result();
}

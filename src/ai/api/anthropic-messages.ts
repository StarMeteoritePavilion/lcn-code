import Anthropic, { type APIRequest, type MiddlewareNext } from "@anthropic-ai/sdk";
import type {
  BetaInputTransformation,
  BetaStopReason,
  BetaTool,
  BetaCacheControlEphemeral as CacheControlEphemeral,
  BetaContentBlockParam as ContentBlockParam,
  MessageCreateParamsStreaming,
  BetaMessageParam as MessageParam,
  BetaRawMessageStreamEvent as RawMessageStreamEvent,
  BetaRefusalStopDetails as RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { calculateCost } from "../models.ts";
import type {
  Api,
  AssistantMessage,
  AnthropicAllowedFallbackModel,
  CacheRetention,
  ImageContent,
  Message,
  Model,
  RequestHeaders,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { retryRequest } from "../utils/request-retry.ts";
import { resolveCacheRetention } from "../utils/cache-retention.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
  getCurrentTools,
  getInitialSystemMessage,
  resolveTranscript,
  type TranscriptContext,
} from "../utils/transcript.ts";

import { resolveStrictJsonSchema } from "./constrained-sampling.ts";
import {
  adjustMaxTokensForThinking,
  buildBaseOptions,
  clampMaxTokensToContext,
} from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * 根据缓存保留策略生成 Anthropic 临时缓存控制配置。
 * @param model - 目标模型，用于判断是否支持长期缓存保留。
 * @param cacheRetention - 缓存保留策略，未提供时按 "short" 处理。
 * @returns 缓存控制配置；策略为 "none" 时返回 undefined。策略为 "long" 且模型支持时附带 1h TTL。
 */
function getCacheControl(
  model: Model<"anthropic-messages">,
  cacheRetention?: CacheRetention,
): CacheControlEphemeral | undefined {
  const retention = cacheRetention ?? "short";
  if (retention === "none") {
    return undefined;
  }
  const ttl =
    retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
  return { type: "ephemeral", ...(ttl && { ttl }) };
}

/**
 * 将文本与图片内容块转换为 Anthropic API 格式。
 * @param content - 待转换的文本或图片内容块。
 * @returns 仅含文本时返回以换行拼接的字符串；含图片时返回内容块数组，若没有文本块则在开头插入占位文本块。
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
            data: string;
          };
        }
    > {
  // 仅有文本块时，将文本拼接为字符串。
  const hasImages = content.some(
    (c: ImageContent | TextContent): c is ImageContent => c.type === "image",
  );
  if (!hasImages) {
    const text = content
      .map((c: ImageContent | TextContent): string => (c as TextContent).text)
      .join("\n");
    return sanitizeSurrogates(text);
  }

  // 包含图片时，转换为内容块数组。
  const blocks = content.map(
    (
      block: ImageContent | TextContent,
    ): Exclude<ReturnType<typeof convertContentBlocks>, string>[number] => {
      if (block.type === "text") {
        return {
          type: "text" as const,
          text: sanitizeSurrogates(block.text),
        };
      }
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: block.data,
        },
      };
    },
  );

  // 仅有图片、没有文本时，添加占位文本块。
  const hasText = blocks.some(
    (b: Exclude<ReturnType<typeof convertContentBlocks>, string>[number]): boolean =>
      b.type === "text",
  );
  if (!hasText) {
    blocks.unshift({
      type: "text" as const,
      text: "(see attached image)",
    });
  }

  return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MID_CONVERSATION_OUTPUT_CONFIG_BETA = "mid-conversation-output-config-2026-07-01";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";

/**
 * 启用原生工具变更时，始终声明一个稳定的延迟工具。Anthropic 会为会话中途的工具变更加入隐藏提示结构；从首次请求起声明此占位工具，可将该结构固定在缓存前缀中，避免首次工具变更使缓存失效（未使用占位工具时实测完全未命中缓存）。该工具永不激活，模型不可见。
 */
const DEFERRED_TOOL_PLACEHOLDER: BetaTool = {
  name: "__pi_deferred_placeholder__",
  description: "Reserved placeholder. Never available. Never call this.",
  input_schema: { type: "object", properties: {}, required: [] },
  defer_loading: true,
};

/** 填充默认值后的 Anthropic 兼容性配置。 */
interface ResolvedAnthropicCompat {
  supportsEagerToolInputStreaming: boolean;
  supportsLongCacheRetention: boolean;
  sendSessionAffinityHeaders: boolean;
  sessionAffinityFormat: "openrouter" | undefined;
  supportsCacheControlOnTools: boolean;
  supportsTemperature: boolean;
  allowEmptySignature: boolean;
  supportsStrictTools: boolean;
  supportsMidConvoSystemMessages: boolean;
  supportsMidConvoToolChanges: boolean;
}

/**
 * 读取模型的 Anthropic 兼容性配置并为缺省字段填充默认值。
 * @param model - 目标模型。
 * @returns 完整的兼容性配置；baseUrl 包含 openrouter.ai 时默认发送会话亲和头并使用 openrouter 格式。
 */
function getAnthropicCompat(model: Model<"anthropic-messages">): ResolvedAnthropicCompat {
  return {
    supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
    sendSessionAffinityHeaders:
      model.compat?.sendSessionAffinityHeaders ?? model.baseUrl.includes("openrouter.ai"),
    sessionAffinityFormat:
      model.compat?.sessionAffinityFormat ??
      (model.baseUrl.includes("openrouter.ai") ? "openrouter" : undefined),
    supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
    supportsTemperature: model.compat?.supportsTemperature ?? true,
    allowEmptySignature: model.compat?.allowEmptySignature ?? false,
    supportsStrictTools: model.compat?.supportsStrictTools ?? false,
    supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
    supportsMidConvoToolChanges: model.compat?.supportsMidConvoToolChanges ?? false,
  };
}

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

interface ServerSentEvent {
  event: string | null;
  data: string;
  raw: string[];
}

interface SseDecoderState {
  event: string | null;
  data: string[];
  raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);

/**
 * 将解码器中累积的字段输出为一个 SSE 事件并重置状态。
 * @param state - SSE 解码器状态，输出事件后会被清空。
 * @returns 累积的事件；既无事件名也无数据行时返回 null（此时不重置原始行）。
 */
function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
  if (!state.event && state.data.length === 0) {
    return null;
  }

  const event: ServerSentEvent = {
    event: state.event,
    data: state.data.join("\n"),
    raw: [...state.raw],
  };
  state.event = null;
  state.data = [];
  state.raw = [];
  return event;
}

/**
 * 解码一行 SSE 文本并更新解码器状态。
 * @param line - 不含换行符的单行文本。
 * @param state - SSE 解码器状态，会记录原始行以及 event、data 字段。
 * @returns 遇到空行时返回累积完成的事件（可能为 null）；其他行返回 null。
 * @remarks 以冒号开头的注释行和 event、data 以外的字段会被忽略，但仍计入原始行。
 */
function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
  if (line === "") {
    return flushSseEvent(state);
  }

  state.raw.push(line);
  if (line.startsWith(":")) {
    return null;
  }

  const delimiterIndex = line.indexOf(":");
  const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
  let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
  if (value.startsWith(" ")) {
    value = value.slice(1);
  }

  if (fieldName === "event") {
    state.event = value;
  } else if (fieldName === "data") {
    state.data.push(value);
  }

  return null;
}

/**
 * 查找文本中第一个 `\r` 或 `\n` 的位置。
 * @param text - 待查找的文本。
 * @returns 第一个换行字符的索引；不存在时返回 -1。
 */
function nextLineBreakIndex(text: string): number {
  const carriageReturnIndex = text.indexOf("\r");
  const newlineIndex = text.indexOf("\n");
  if (carriageReturnIndex === -1) {
    return newlineIndex;
  }
  if (newlineIndex === -1) {
    return carriageReturnIndex;
  }
  return Math.min(carriageReturnIndex, newlineIndex);
}

/**
 * 从文本开头取出一行，支持 `\r`、`\n` 和 `\r\n` 换行。
 * @param text - 待切分的缓冲文本。
 * @returns 去除换行符的首行及剩余文本；文本中没有完整行时返回 null。
 */
function consumeLine(text: string): { line: string; rest: string } | null {
  const lineBreakIndex = nextLineBreakIndex(text);
  if (lineBreakIndex === -1) {
    return null;
  }

  let nextIndex = lineBreakIndex + 1;
  if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
    nextIndex += 1;
  }

  return {
    line: text.slice(0, lineBreakIndex),
    rest: text.slice(nextIndex),
  };
}

/**
 * 逐个读取响应体中的 SSE 事件。
 * @param body - 响应体字节流。
 * @param signal - 可选的中止信号，每次读取前检查。
 * @returns 依次产出解析后 SSE 事件的异步生成器；流结束时会输出末尾未以空行结束的事件。
 * @throws 当 signal 已中止时抛出 "Request was aborted" 错误。
 * @remarks 结束或异常时释放读取器锁。
 */
async function* iterateSseMessages(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: SseDecoderState = { event: null, data: [], raw: [] };
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }

      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let consumed = consumeLine(buffer);
      while (consumed) {
        buffer = consumed.rest;
        const event = decodeSseLine(consumed.line, state);
        if (event) {
          yield event;
        }
        consumed = consumeLine(buffer);
      }
    }

    buffer += decoder.decode();
    let consumed = consumeLine(buffer);
    while (consumed) {
      buffer = consumed.rest;
      const event = decodeSseLine(consumed.line, state);
      if (event) {
        yield event;
      }
      consumed = consumeLine(buffer);
    }

    if (buffer.length > 0) {
      const event = decodeSseLine(buffer, state);
      if (event) {
        yield event;
      }
    }

    const trailingEvent = flushSseEvent(state);
    if (trailingEvent) {
      yield trailingEvent;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 将 Anthropic 响应的 SSE 流解析为消息流事件。
 * @param response - Anthropic Messages 流式响应。
 * @param signal - 可选的中止信号。
 * @returns 依次产出消息流事件的异步生成器；非消息类 SSE 事件（如 ping）会被跳过。
 * @throws 响应无 body、收到 error 事件、事件 JSON 无法解析，或收到 message_start 后未收到 message_stop 即结束时抛出错误。
 */
async function* iterateAnthropicEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
  if (!response.body) {
    throw new Error("Attempted to iterate over an Anthropic response with no body");
  }

  let hasSeenMessageStart = false;
  let hasSeenMessageEnd = false;

  for await (const sse of iterateSseMessages(response.body, signal)) {
    if (sse.event === "error") {
      throw new Error(sse.data);
    }

    if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
      continue;
    }

    try {
      const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
      if (event.type === "message_start") {
        hasSeenMessageStart = true;
      } else if (event.type === "message_stop") {
        hasSeenMessageEnd = true;
      }
      yield event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
      );
    }
  }

  if (hasSeenMessageStart && !hasSeenMessageEnd) {
    throw new Error("Anthropic stream ended before message_stop");
  }
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
      let usageModel = model;
      let inputTransformations: BetaInputTransformation[] | undefined;
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

      type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & {
        index: number;
      };
      const blocks = output.content as Block[];

      for await (const event of iterateAnthropicEvents(response, options?.signal)) {
        await (options?.onStreamEvent ?? options?.onProviderStreamEvent)?.(event, model);
        if (event.type === "message_start") {
          output.responseId = event.message.id;
          const transformations = event.message.input_transformations;
          if (Array.isArray(transformations)) {
            inputTransformations = transformations;
          }
          const responseModel = event.message.model;
          if (responseModel !== model.id) {
            output.responseModel = responseModel;
          }
          const fallback =
            responseModel === model.id
              ? undefined
              : model.compat?.allowedFallbackModels?.find(
                  (entry: AnthropicAllowedFallbackModel): boolean => entry.model === responseModel,
                );
          usageModel = fallback ? { ...model, id: responseModel, cost: fallback.cost } : model;
          // 从 message_start 记录初始用量，确保流提前中断时仍保留输入 token 数。
          output.usage.input = event.message.usage.input_tokens || 0;
          output.usage.output = event.message.usage.output_tokens || 0;
          output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
          output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
          output.usage.cacheWrite1h =
            event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
          // Anthropic 不提供 total_tokens，按各项用量求和。
          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
          calculateCost(usageModel, output.usage);
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "fallback") {
            if (output.content.length > 0) {
              throw new Error("Anthropic performed an unsupported mid-output model fallback");
            }
            continue;
          }
          if (event.content_block.type === "text") {
            const block: Block = {
              type: "text",
              text: event.content_block.text ?? "",
              index: event.index,
            };
            output.content.push(block);
            stream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "thinking") {
            const block: Block = {
              type: "thinking",
              thinking: event.content_block.thinking ?? "",
              thinkingSignature: event.content_block.signature ?? "",
              index: event.index,
            };
            output.content.push(block);
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "redacted_thinking") {
            const block: Block = {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: event.content_block.data,
              redacted: true,
              index: event.index,
            };
            output.content.push(block);
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "tool_use") {
            const block: Block = {
              type: "toolCall",
              id: event.content_block.id,
              name: event.content_block.name,
              arguments: (event.content_block.input as ToolCall["arguments"]) ?? {},
              partialJson: "",
              index: event.index,
            };
            output.content.push(block);
            stream.push({
              type: "toolcall_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
        } else if (event.type === "content_block_delta") {
          const index = blocks.findIndex(
            (
              b: (TextContent | ThinkingContent | (ToolCall & { partialJson: string })) & {
                index: number;
              },
            ): boolean => b.index === event.index,
          );
          const block = blocks[index];
          if (event.delta.type === "text_delta") {
            if (block && block.type === "text") {
              block.text += event.delta.text;
              stream.push({
                type: "text_delta",
                contentIndex: index,
                delta: event.delta.text,
                partial: output,
              });
            }
          } else if (event.delta.type === "thinking_delta") {
            if (block && block.type === "thinking") {
              block.thinking += event.delta.thinking;
              stream.push({
                type: "thinking_delta",
                contentIndex: index,
                delta: event.delta.thinking,
                partial: output,
              });
            }
          } else if (event.delta.type === "input_json_delta") {
            if (block && block.type === "toolCall") {
              block.partialJson += event.delta.partial_json;
              block.arguments = parseStreamingJson(block.partialJson);
              stream.push({
                type: "toolcall_delta",
                contentIndex: index,
                delta: event.delta.partial_json,
                partial: output,
              });
            }
          } else if (event.delta.type === "signature_delta") {
            if (block && block.type === "thinking") {
              block.thinkingSignature = block.thinkingSignature || "";
              block.thinkingSignature += event.delta.signature;
            }
          }
        } else if (event.type === "content_block_stop") {
          const index = blocks.findIndex(
            (
              b: (TextContent | ThinkingContent | (ToolCall & { partialJson: string })) & {
                index: number;
              },
            ): boolean => b.index === event.index,
          );
          const block = blocks[index];
          if (block) {
            delete (block as { index?: number }).index;
            if (block.type === "text") {
              stream.push({
                type: "text_end",
                contentIndex: index,
                content: block.text,
                partial: output,
              });
            } else if (block.type === "thinking") {
              stream.push({
                type: "thinking_end",
                contentIndex: index,
                content: block.thinking,
                partial: output,
              });
            } else if (block.type === "toolCall") {
              block.arguments = parseStreamingJson(block.partialJson);
              // 就地完成工具参数解析并删除临时缓冲区，回放仅保留已解析参数。
              delete (block as { partialJson?: string }).partialJson;
              stream.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall: block,
                partial: output,
              });
            }
          }
        } else if (event.type === "message_delta") {
          const transformations = event.input_transformations;
          if (Array.isArray(transformations)) {
            inputTransformations = transformations;
          }
          if (event.delta.stop_reason) {
            output.rawStopReason = event.delta.stop_reason;
            const stopReasonResult = mapStopReason(
              event.delta.stop_reason,
              event.delta.stop_details,
            );
            output.stopReason = stopReasonResult.stopReason;
            if (stopReasonResult.errorMessage) {
              output.errorMessage = stopReasonResult.errorMessage;
            }
          }
          // 仅更新非 null 的用量字段；代理在 message_delta 中省略 input_tokens 时，保留 message_start 中的数值。
          if (event.usage) {
            if (event.usage.input_tokens != null) {
              output.usage.input = event.usage.input_tokens;
            }
            if (event.usage.output_tokens != null) {
              output.usage.output = event.usage.output_tokens;
            }
            if (event.usage.cache_read_input_tokens != null) {
              output.usage.cacheRead = event.usage.cache_read_input_tokens;
            }
            if (event.usage.cache_creation_input_tokens != null) {
              output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
            }
            // Vercel AI Gateway 会在增量事件中返回 TTL 明细，但 SDK 只在 message_start 中声明该类型。
            const cacheCreation = (
              event.usage as typeof event.usage & {
                cache_creation?: { ephemeral_1h_input_tokens?: number };
              }
            ).cache_creation;
            if (cacheCreation?.ephemeral_1h_input_tokens != null) {
              output.usage.cacheWrite1h = cacheCreation.ephemeral_1h_input_tokens;
            }
            // Anthropic 的推理 token 数包含在输出 token 数中。
            const thinkingTokens = event.usage.output_tokens_details?.thinking_tokens;
            if (thinkingTokens != null) {
              output.usage.reasoning = thinkingTokens;
            }
          }
          // Anthropic 不提供 total_tokens，按各项用量求和。
          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
          calculateCost(usageModel, output.usage);
        }
      }

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
 * 获取请求使用的最大输出 token 数，优先使用请求选项。
 * @param model - 目标模型，选项未提供时使用其 maxTokens。
 * @param options - 可选的请求选项。
 * @returns 正整数形式的最大输出 token 数。
 * @throws 选项与模型都未提供 maxTokens，或取值不是正的安全整数时抛出错误。
 */
function requireMaxTokens(model: Model<"anthropic-messages">, options?: StreamOptions): number {
  const maxTokens = options?.maxTokens ?? model.maxTokens;
  if (maxTokens === undefined || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(
      "Anthropic Messages requires a positive integer maxTokens in the model or request options",
    );
  }
  return maxTokens;
}

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

/**
 * 计算请求需要启用的 Anthropic beta 特性列表。
 * @param model - 目标模型。
 * @param context - 会话上下文，用于判断当前是否存在工具。
 * @param shouldUseNativeToolChanges - 是否使用原生会话中工具变更，为 true 时启用 inline tools beta。
 * @param options - 可选的请求选项。
 * @returns 去重后的 beta 特性列表。
 * @remarks 模型或请求头中显式配置了 anthropic-beta 时（后者覆盖前者）直接使用该配置：值为 null 返回空数组，
 * 否则按逗号拆分、去除空白并去重；未配置时根据工具流式、交错思考、服务端回退、会话中 effort 与工具变更能力自动推导。
 */
function getBetaFeatures(
  model: Model<"anthropic-messages">,
  context: TranscriptContext,
  shouldUseNativeToolChanges: boolean,
  options?: AnthropicOptions,
): NonNullable<MessageCreateParamsStreaming["betas"]> {
  let configuredFeatures: string | null | undefined;
  for (const headers of [model.headers, options?.headers]) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (name.toLowerCase() === "anthropic-beta") {
        configuredFeatures = value;
      }
    }
  }
  if (configuredFeatures === null) {
    return [];
  }
  if (configuredFeatures !== undefined) {
    const parsedFeatures = configuredFeatures
      .split(",")
      .map((feature: string): string => feature.trim());
    const nonemptyFeatures = parsedFeatures.filter(
      (feature: string): boolean => feature.length > 0,
    );
    return [...new Set(nonemptyFeatures)];
  }

  const features: NonNullable<MessageCreateParamsStreaming["betas"]> = [];
  if (
    getCurrentTools(context.messages).length > 0 &&
    !getAnthropicCompat(model).supportsEagerToolInputStreaming
  ) {
    features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  if (
    model.reasoning !== false &&
    options?.thinkingEnabled === true &&
    (options.interleavedThinking ?? true) &&
    model.compat?.forceAdaptiveThinking !== true
  ) {
    features.push(INTERLEAVED_THINKING_BETA);
  }
  if ((model.compat?.allowedFallbackModels?.length ?? 0) > 0) {
    features.push(SERVER_SIDE_FALLBACK_BETA);
  }
  if (model.compat?.supportsMidConvoEffort === true) {
    features.push(MID_CONVERSATION_OUTPUT_CONFIG_BETA, THINKING_BINDING_CONTROLS_BETA);
  }
  if (shouldUseNativeToolChanges) {
    features.push(INLINE_TOOLS_BETA);
  }
  return [...new Set(features)];
}

/**
 * 根据模型、会话上下文和选项构建 Anthropic Messages 流式请求参数。
 * @param model - 目标模型。
 * @param context - 会话上下文，首条系统消息作为顶层 system，其余消息转换为请求消息。
 * @param options - 可选的请求选项，控制缓存、温度、思考、工具选择与元数据。
 * @returns 设置了 stream: true 的请求参数。
 * @throws 选项与模型都未提供有效 maxTokens，或消息数组包含空位时抛出错误。
 * @remarks 模型同时支持会话中系统消息与工具变更且首条系统消息带有工具时，固定请求级工具列表并追加延迟加载占位工具，
 * 后续工具变更以内联块表达以保持缓存前缀；支持会话中 effort 的模型始终使用自适应思考并插入推理级别系统消息。
 */
function buildParams(
  model: Model<"anthropic-messages">,
  context: TranscriptContext,
  options?: AnthropicOptions,
): MessageCreateParamsStreaming {
  const cacheControl = getCacheControl(model, options?.cacheRetention);
  const compat = getAnthropicCompat(model);
  const initialSystemMessage = getInitialSystemMessage(context.messages);
  const initialSystemText = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
  const conversationMessages = initialSystemMessage
    ? transformedMessages.slice(1)
    : transformedMessages;
  // 原生工具变更保持请求级工具列表固定，后续工具通过 tool_addition 携带完整定义，也支持同名重新定义。Anthropic 拒绝全部工具均为延迟工具的列表，因此必须有初始活动工具来承载占位工具；否则发送当前工具列表。
  const initialTools = initialSystemMessage?.toolsAdded ?? [];
  const shouldUseNativeToolChanges =
    compat.supportsMidConvoSystemMessages &&
    compat.supportsMidConvoToolChanges &&
    initialTools.length > 0;
  const converted = convertMessages(
    conversationMessages,
    cacheControl,
    compat.allowEmptySignature,
    model.compat?.supportsMidConvoEffort === true ? model : undefined,
    shouldUseNativeToolChanges
      ? (tools: Tool[]): BetaTool[] =>
          convertTools(tools, compat.supportsEagerToolInputStreaming, compat.supportsStrictTools)
      : undefined,
  );
  const activeEffort = options?.effort ?? "high";
  const betaFeatures = getBetaFeatures(model, context, shouldUseNativeToolChanges, options);
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    messages:
      model.compat?.supportsMidConvoEffort === true
        ? insertThinkingLevelMessages(converted, activeEffort)
        : converted.messages,
    max_tokens: requireMaxTokens(model, options),
    stream: true,
    ...(betaFeatures.length > 0 ? { betas: betaFeatures } : {}),
  };

  if (initialSystemText) {
    params.system = [
      {
        type: "text",
        text: sanitizeSurrogates(initialSystemText),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      },
    ];
  }

  // temperature 与扩展思考不兼容，Claude Opus 4.7+ 也不支持该字段。
  if (
    options?.temperature !== undefined &&
    !options?.thinkingEnabled &&
    model.compat?.supportsMidConvoEffort !== true &&
    compat.supportsTemperature
  ) {
    params.temperature = options.temperature;
  }

  const toolCacheControl = compat.supportsCacheControlOnTools ? cacheControl : undefined;
  if (shouldUseNativeToolChanges) {
    // 初始工具保持激活，在最后一个工具上设置缓存断点，再追加占位工具。后续列表不变：通过 tool_addition 定义新工具、通过 tool_removal 撤回工具，从而在工具变更时保留缓存前缀。
    params.tools = [
      ...convertTools(
        initialTools,
        compat.supportsEagerToolInputStreaming,
        compat.supportsStrictTools,
        toolCacheControl,
      ),
      DEFERRED_TOOL_PLACEHOLDER,
    ];
  } else {
    const tools = getCurrentTools(context.messages);
    if (tools.length > 0) {
      params.tools = convertTools(
        tools,
        compat.supportsEagerToolInputStreaming,
        compat.supportsStrictTools,
        toolCacheControl,
      );
    }
  }

  // 受 effort 管理的模型始终使用自适应思考，以便丢弃前缀不匹配的思考，避免持续返回 400。
  if (model.compat?.supportsMidConvoEffort === true) {
    params.thinking = {
      type: "adaptive",
      display: options?.thinkingDisplay ?? "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    };
    params.output_config = { effort: "high" };
  } else if (model.reasoning !== false) {
    if (options?.thinkingEnabled) {
      // 默认 summarized，使 Opus 4.7 与 Mythos Preview 的行为与旧 Claude 4 模型保持一致；旧模型的 API 默认值也是 summarized。
      const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
      if (model.compat?.forceAdaptiveThinking === true) {
        // 自适应思考由 Claude 自行决定何时思考及思考预算。
        params.thinking = { type: "adaptive", display };
        if (options.effort) {
          params.output_config = { effort: options.effort };
        }
      } else {
        // 旧模型采用 token 预算思考。
        const budget = options.thinkingBudgetTokens ?? 1024;
        params.thinking = {
          type: "enabled",
          budget_tokens: budget,
          display,
        };
      }
    } else if (
      options?.thinkingEnabled === false &&
      model.reasoning === true &&
      model.thinkingLevelMap?.off !== null
    ) {
      params.thinking = { type: "disabled" };
    }
  }

  if (options?.metadata) {
    const userId = options.metadata.user_id;
    if (typeof userId === "string") {
      params.metadata = { user_id: userId };
    }
  }

  if (options?.toolChoice) {
    if (typeof options.toolChoice === "string") {
      params.tool_choice = { type: options.toolChoice };
    } else {
      params.tool_choice = options.toolChoice;
    }
  }

  const allowedFallbackModels = model.compat?.allowedFallbackModels;
  if (allowedFallbackModels && allowedFallbackModels.length > 0) {
    params.fallbacks = allowedFallbackModels.map(
      (fallback: AnthropicAllowedFallbackModel): { model: string } => ({
        model: fallback.model,
      }),
    );
  }

  return params;
}

/**
 * 规范化工具调用 ID，使其符合 Anthropic 要求的字符集与长度。
 * @param id - 原始工具调用 ID。
 * @returns 将字母、数字、下划线和连字符以外的字符替换为下划线并截断至 64 个字符后的 ID。
 */
function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * 将工具结果消息转换为 Anthropic tool_result 内容块。
 * @param msg - 工具结果消息。
 * @returns 关联工具调用 ID、携带转换后内容与错误标记的 tool_result 内容块。
 */
function convertToolResult(msg: ToolResultMessage): ContentBlockParam {
  return {
    type: "tool_result",
    tool_use_id: msg.toolCallId,
    content: convertContentBlocks(msg.content),
    is_error: msg.isError,
  };
}

interface ConvertedAnthropicMessages {
  messages: MessageParam[];
  assistantLevels: Map<number, AnthropicEffort>;
}

/**
 * 将转换后的会话消息整理为 Anthropic 请求消息，并记录助手消息的推理级别。
 * @param transformedMessages - 已完成跨提供商转换的消息，连续工具结果会合并为一条用户消息。
 * @param cacheControl - 附加到最后一条用户或系统消息内容块的缓存配置。
 * @param canKeepEmptySignature - 是否保留缺少签名的思考块并使用空签名，为 false 时将其转换为文本块，默认为 false。
 * @param managedModel - 用于筛选需要记录历史推理级别的助手消息的模型，未提供时不记录。
 * @param convertToolDefinitions - 将新增工具转换为原生工具定义的函数，未提供时不生成工具变更块。
 * @returns 请求消息及其助手消息索引对应的推理级别；没有消息时返回空数组和空映射。
 * @throws 当消息数组存在空位或包含 undefined 时抛出错误。
 * @remarks 后续系统消息延迟到下一条助手消息之前或会话末尾输出，避免分隔工具调用与工具结果。
 */
function convertMessages(
  transformedMessages: Message[],
  cacheControl?: CacheControlEphemeral,
  canKeepEmptySignature: boolean = false,
  managedModel?: Model<"anthropic-messages">,
  convertToolDefinitions?: (tools: Tool[]) => BetaTool[],
): ConvertedAnthropicMessages {
  const params: MessageParam[] = [];
  const assistantLevels = new Map<number, AnthropicEffort>();
  // 后续系统消息延迟到下一条助手消息之前发送，或在会话末尾发送。Anthropic 要求 tool_result 紧跟对应的 tool_use，二者之间插入系统消息会被拒绝；此顺序也与受管理的 effort 系统消息一致。因此，会话中位于用户消息之前的系统更新，在请求中会移到该用户消息之后。
  const pendingSystemMessages: MessageParam[] = [];
  /** 将暂存的系统消息按顺序追加到请求消息末尾并清空暂存区。 */
  const flushPendingSystemMessages = (): void => {
    params.push(...pendingSystemMessages);
    pendingSystemMessages.length = 0;
  };

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (msg === undefined) {
      throw new Error(`Missing message at index ${i}`);
    }

    if (msg.role === "system") {
      // 仅支持原生会话中系统消息的模型会执行此分支；其他模型已在转换前将会话折叠到初始系统消息。
      const text = renderSystemMessageUpdate(msg);
      const blocks: ContentBlockParam[] = [];
      if (text.length > 0) {
        blocks.push({ type: "text", text: sanitizeSurrogates(text) });
      }
      if (convertToolDefinitions) {
        const added = msg.toolsAdded ?? [];
        const redefined = new Set(added.map((tool: Tool): string => tool.name));
        for (const tool of msg.toolsRemoved ?? []) {
          // 同名新定义会替换旧定义，无需先移除。
          if (redefined.has(tool.name)) {
            continue;
          }
          blocks.push({
            type: "tool_removal",
            tool: { type: "tool_reference", name: tool.name },
          });
        }
        for (const definition of convertToolDefinitions(added)) {
          blocks.push({ type: "tool_addition", tool: { type: "tool_definition", definition } });
        }
      }
      if (blocks.length > 0) {
        pendingSystemMessages.push({ role: "system", content: blocks });
      }
    } else if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          params.push({
            role: "user",
            content: sanitizeSurrogates(msg.content),
          });
        }
      } else {
        const blocks: ContentBlockParam[] = msg.content.map(
          (item: ImageContent | TextContent): ContentBlockParam => {
            if (item.type === "text") {
              return {
                type: "text",
                text: sanitizeSurrogates(item.text),
              };
            } else {
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: item.mimeType as
                    "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                  data: item.data,
                },
              };
            }
          },
        );
        const filteredBlocks = blocks.filter((b: ContentBlockParam): boolean => {
          if (b.type === "text") {
            return b.text.trim().length > 0;
          }
          return true;
        });
        if (filteredBlocks.length === 0) {
          continue;
        }
        params.push({
          role: "user",
          content: filteredBlocks,
        });
      }
    } else if (msg.role === "assistant") {
      flushPendingSystemMessages();
      const blocks: ContentBlockParam[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) {
            continue;
          }
          blocks.push({
            type: "text",
            text: sanitizeSurrogates(block.text),
          });
        } else if (block.type === "thinking") {
          // 将已遮蔽的思考载荷原样回传为 redacted_thinking。
          if (block.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature!,
            });
            continue;
          }
          const thinkingSignature = block.thinkingSignature;
          const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
          if (block.thinking.trim().length === 0 && !hasThinkingSignature) {
            continue;
          }
          // 思考签名缺失或为空时（例如流中断），将思考转换为 Anthropic 普通文本。部分兼容提供商接受并返回空签名，因此显式标记的模型保留原块。
          if (!hasThinkingSignature) {
            blocks.push(
              canKeepEmptySignature
                ? {
                    type: "thinking",
                    thinking: sanitizeSurrogates(block.thinking),
                    signature: "",
                  }
                : {
                    type: "text",
                    text: sanitizeSurrogates(block.thinking),
                  },
            );
          } else {
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature: thinkingSignature,
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments ?? {},
          });
        }
      }
      if (blocks.length === 0) {
        continue;
      }
      const messageIndex = params.length;
      params.push({
        role: "assistant",
        content: blocks,
      });
      if (
        managedModel !== undefined &&
        msg.api === "anthropic-messages" &&
        msg.baseUrl === managedModel.baseUrl &&
        msg.model === managedModel.id &&
        isAnthropicEffort(msg.thinkingEffort)
      ) {
        assistantLevels.set(messageIndex, msg.thinkingEffort);
      }
    } else if (msg.role === "toolResult") {
      // 收集全部连续 toolResult 消息，满足 z.ai Anthropic 端点要求。
      const toolResults: ContentBlockParam[] = [];
      let j = i;
      while (j < transformedMessages.length) {
        const toolResult = transformedMessages[j];
        if (toolResult === undefined) {
          throw new Error(`Missing message at index ${j}`);
        }
        if (toolResult.role !== "toolResult") {
          break;
        }

        toolResults.push(convertToolResult(toolResult));
        j++;
      }

      // 跳过已处理的消息。
      i = j - 1;

      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }

  flushPendingSystemMessages();

  // 在最后一条用户或系统消息上添加 cache_control，缓存会话历史。
  if (cacheControl && params.length > 0) {
    const lastMessage = params[params.length - 1];
    if (
      lastMessage !== undefined &&
      (lastMessage.role === "user" || lastMessage.role === "system")
    ) {
      if (Array.isArray(lastMessage.content)) {
        const lastBlock = lastMessage.content[lastMessage.content.length - 1];
        if (
          lastBlock &&
          (lastBlock.type === "text" ||
            lastBlock.type === "image" ||
            lastBlock.type === "tool_result" ||
            lastBlock.type === "tool_addition" ||
            lastBlock.type === "tool_removal")
        ) {
          Object.assign(lastBlock, { cache_control: cacheControl });
        }
      } else if (typeof lastMessage.content === "string") {
        lastMessage.content = [
          {
            type: "text",
            text: lastMessage.content,
            cache_control: cacheControl,
          },
        ];
      }
    }
  }

  return { messages: params, assistantLevels };
}

function isAnthropicEffort(value: unknown): value is AnthropicEffort {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

/**
 * 在助手消息前插入已记录的历史推理级别，并在会话末尾设置当前推理级别。
 * @param converted - 转换后的请求消息及助手消息索引对应的历史推理级别。
 * @param activeEffort - 会话末尾设置的当前推理级别。
 * @returns 保持原消息顺序的新数组；原消息为空时仅包含当前推理级别的系统消息。
 */
function insertThinkingLevelMessages(
  converted: ConvertedAnthropicMessages,
  activeEffort: AnthropicEffort,
): MessageParam[] {
  const messages: MessageParam[] = [];
  for (const [index, message] of converted.messages.entries()) {
    const historicalEffort = converted.assistantLevels.get(index);
    if (historicalEffort !== undefined) {
      messages.push({ role: "system", content: [], output_config: { effort: historicalEffort } });
    }
    messages.push(message);
  }
  messages.push({ role: "system", content: [], output_config: { effort: activeEffort } });
  return messages;
}

// Anthropic 严格工具模式拒绝的关键字会使整个请求返回 400。
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
const ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
]);
const ANTHROPIC_STRICT_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/**
 * 判断 JSON Schema 关键字及其取值是否会被 Anthropic 严格工具模式拒绝。
 * @param key - Schema 关键字名称。
 * @param value - 关键字对应的取值。
 * @returns 不受支持时返回 true：数值与数量约束类关键字、取值不是 0 或 1 的 minItems、以及不在支持列表中的 format。
 */
function isAnthropicStrictUnsupportedKeyword(key: string, value: unknown): boolean {
  if (ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS.has(key)) {
    return true;
  }
  if (key === "minItems") {
    return value !== 0 && value !== 1;
  }
  if (key === "format") {
    return typeof value !== "string" || !ANTHROPIC_STRICT_STRING_FORMATS.has(value);
  }
  return false;
}

/**
 * 将通用工具定义转换为 Anthropic 工具定义。
 * @param tools - 待转换的工具列表。
 * @param canEagerStreamToolInput - 端点是否支持逐工具的 eager_input_streaming，为 true 时为每个工具开启。
 * @param canUseStrictTools - 端点是否支持严格工具 schema。
 * @param cacheControl - 可选的缓存控制配置，仅附加到最后一个工具。
 * @returns Anthropic 工具定义列表；tools 为空值时返回空数组。
 * @throws 工具要求严格约束采样但无法满足时，由 resolveStrictJsonSchema 抛出错误。
 * @remarks 能解析出严格 schema 的工具会设置 strict: true 并保留完整 schema，其余工具仅保留 properties 与 required。
 */
function convertTools(
  tools: Tool[],
  canEagerStreamToolInput: boolean,
  canUseStrictTools: boolean,
  cacheControl?: CacheControlEphemeral,
): BetaTool[] {
  if (!tools) {
    return [];
  }

  return tools.map((tool: Tool, index: number): BetaTool => {
    const strictParameters = resolveStrictJsonSchema(
      tool,
      canUseStrictTools,
      isAnthropicStrictUnsupportedKeyword,
    );
    const isStrict = strictParameters !== undefined;
    const parameters = strictParameters ?? tool.parameters;
    const schema = parameters as { properties?: unknown; required?: string[] };
    const legacyInputSchema = {
      type: "object" as const,
      properties: schema.properties ?? {},
      required: schema.required ?? [],
    };
    const inputSchema =
      isStrict === true
        ? {
            ...(parameters as Record<string, unknown>),
            ...legacyInputSchema,
          }
        : legacyInputSchema;

    return {
      name: tool.name,
      description: tool.description,
      ...(canEagerStreamToolInput ? { eager_input_streaming: true } : {}),
      ...(isStrict === true ? { strict: true } : {}),
      input_schema: inputSchema,
      ...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
    };
  });
}

/**
 * 将 Anthropic 停止原因映射为统一的停止原因。
 * @param reason - Anthropic 返回的停止原因。
 * @param stopDetails - 可选的拒绝详情，用于生成 refusal 的错误信息。
 * @returns 统一的停止原因；refusal 与 sensitive 映射为 "error" 并附带错误信息，pause_turn 与 stop_sequence 视为 "stop"。
 * @throws 遇到未知停止原因时抛出错误。
 */
function mapStopReason(
  reason: BetaStopReason | string,
  stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string } {
  switch (reason) {
    case "end_turn":
      return { stopReason: "stop" };
    case "max_tokens":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal":
      return {
        stopReason: "error",
        errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
      };
    case "pause_turn": // 按正常停止处理，允许调用方再次提交请求。
      return { stopReason: "stop" };
    case "stop_sequence":
      return { stopReason: "stop" }; // 本实现未提供停止序列，因此不会主动触发该停止原因。
    case "sensitive": // 内容被安全过滤器标记，SDK 类型尚未包含此停止原因。
      return { stopReason: "error", errorMessage: "Anthropic Messages stopped with: sensitive" };
    default:
      // 处理未知停止原因，避免 API 新增取值时默默忽略。
      throw new Error(`Unhandled stop reason: ${reason}`);
  }
}

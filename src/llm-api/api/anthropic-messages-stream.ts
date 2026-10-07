import type {
  BetaInputTransformation,
  BetaStopReason,
  BetaRawMessageStreamEvent as RawMessageStreamEvent,
  BetaRefusalStopDetails as RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { calculateCost } from "../models.ts";
import type {
  AssistantMessage,
  AnthropicAllowedFallbackModel,
  Model,
  StopReason,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";

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
 * 消费 Anthropic SSE 响应并累积助手内容、用量和停止原因。
 * @param response - 已建立的流式响应。
 * @param model - 请求模型及允许的回退模型单价。
 * @param output - 本次请求的助手消息，会就地更新。
 * @param stream - 内容事件输出流，不在此推送公共 start、done 或 error。
 * @param signal - 可选的取消信号，读取响应时检查。
 * @param onStreamEvent - 每个原生事件解析前执行的回调。
 * @returns 解析完成后的服务端输入变换记录；未收到该字段时为 undefined。
 * @throws SSE 解码、原生回调失败，缺少 message_stop，取消或输出中途发生模型回退时拒绝。
 * @remarks 内容块仅在收到 content_block_stop 时清理临时字段；终态检查、诊断追加和失败清理由入口处理。
 */
export async function processAnthropicStream(
  response: Response,
  model: Model<"anthropic-messages">,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  signal?: AbortSignal,
  onStreamEvent?: StreamOptions["onStreamEvent"],
): Promise<{ inputTransformations: BetaInputTransformation[] | undefined }> {
  let usageModel = model;
  let inputTransformations: BetaInputTransformation[] | undefined;
  type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & {
    index: number;
  };
  const blocks = output.content as Block[];

  for await (const event of iterateAnthropicEvents(response, signal)) {
    await onStreamEvent?.(event, model);
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
        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
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
        const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
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
        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
      calculateCost(usageModel, output.usage);
    }
  }
  return { inputTransformations };
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

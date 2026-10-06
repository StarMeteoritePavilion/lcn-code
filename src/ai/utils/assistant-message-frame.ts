import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "../types.ts";
import { parseStreamingJson } from "./json-parse.ts";

/**
 * 紧凑、可回放的助手消息进度。终止结算不包含在帧中，必须单独持久化。
 */
export type AssistantMessageFrame =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; content: TextContent }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string; textSignature?: string }
  | { type: "thinking_start"; contentIndex: number; content: ThinkingContent }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
      thinkingSignature?: string;
      redacted?: boolean;
    }
  | { type: "toolcall_start"; contentIndex: number; toolCall: ToolCall }
  | { type: "toolcall_checkpoint"; contentIndex: number; json: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | {
      type: "toolcall_end";
      contentIndex: number;
      id: string;
      name: string;
      arguments: ToolCall["arguments"];
      namespace?: string;
    };

type EncoderBlockState =
  | { kind: "text" | "thinking"; coveredChars: number; deltaChars: number }
  | {
      kind: "toolCall";
      caughtUp: boolean;
      catchupJson: string;
      snapshotArguments: string;
    };

type ContentEvent = Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }>;

type ReducerBlockState =
  | { kind: "text"; ended: boolean }
  | { kind: "thinking"; ended: boolean }
  | { kind: "toolCall"; ended: boolean; json: string };

function cloneTextContent(content: TextContent): TextContent {
  return {
    type: "text",
    text: content.text,
    ...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
  };
}

function cloneThinkingContent(content: ThinkingContent): ThinkingContent {
  return {
    type: "thinking",
    thinking: content.thinking,
    ...(content.thinkingSignature === undefined
      ? {}
      : { thinkingSignature: content.thinkingSignature }),
    ...(content.redacted === undefined ? {} : { redacted: content.redacted }),
  };
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  return {
    type: "toolCall",
    id: toolCall.id,
    name: toolCall.name,
    arguments: structuredClone(toolCall.arguments),
    ...(toolCall.namespace === undefined ? {} : { namespace: toolCall.namespace }),
  };
}

/**
 * 复制 start 事件中的消息元数据，生成内容为空、状态为 pending 的起始消息。
 *
 * @param message - start 事件携带的实时累积消息。
 * @returns 新的助手消息：`content` 为空数组，`stopReason` 为 `"pending"`，`usage` 与 `diagnostics` 深拷贝。
 * @remarks 不复制已累积的内容块与终止信息，内容由后续帧重建。
 */
function cloneStartMessage(message: AssistantMessage): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: message.api,
    baseUrl: message.baseUrl,
    model: message.model,
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    ...(message.thinkingEffort === undefined ? {} : { thinkingEffort: message.thinkingEffort }),
    ...(message.diagnostics === undefined
      ? {}
      : { diagnostics: structuredClone(message.diagnostics) }),
    usage: structuredClone(message.usage),
    stopReason: "pending",
    timestamp: message.timestamp,
  };
}

/**
 * 校验内容块索引为非负安全整数。
 *
 * @param contentIndex - 待校验的内容块索引。
 * @throws Error 索引不是安全整数或小于 0 时抛出。
 */
function assertContentIndex(contentIndex: number): void {
  if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) {
    throw new Error(`Invalid assistant message frame contentIndex: ${contentIndex}`);
  }
}

/**
 * 获取内容事件在实时累积消息中指向的内容块。
 *
 * @param event - 除 start、done、error 之外的助手消息事件。
 * @returns `event.partial.content[event.contentIndex]` 对应的内容块。
 * @throws Error 索引非法或该索引处不存在内容块时抛出。
 */
function eventBlock(event: ContentEvent): AssistantMessage["content"][number] {
  assertContentIndex(event.contentIndex);
  const block = event.partial.content[event.contentIndex];
  if (!block) {
    throw new Error(`${event.type} event has no content block at index ${event.contentIndex}`);
  }
  return block;
}

/**
 * 将工具调用参数序列化为 JSON 字符串，用于快照比较。
 *
 * @param argumentsValue - 工具调用参数。
 * @returns 参数的 JSON 序列化结果。
 * @throws Error 参数无法序列化为 JSON（`JSON.stringify` 返回 `undefined`）时抛出。
 */
function serializedArguments(argumentsValue: ToolCall["arguments"]): string {
  const serialized = JSON.stringify(argumentsValue);
  if (serialized === undefined) {
    throw new Error("Tool-call arguments are not JSON-serializable");
  }
  return serialized;
}

const EMPTY_PARSED_TOOL_ARGUMENTS = serializedArguments(
  parseStreamingJson<ToolCall["arguments"]>(""),
);

/**
 * 判断快照值是否为当前值在流式解析意义上的前缀。
 *
 * @param snapshot - 较早的解析快照。
 * @param current - 当前解析结果。
 * @returns 字符串为前缀、数组逐项为前缀且长度不超过当前值、对象的每个键都存在且值为前缀、其余值通过 `Object.is` 相等时返回 `true`。
 */
function isJsonPrefix(snapshot: unknown, current: unknown): boolean {
  if (typeof snapshot === "string") {
    return typeof current === "string" && current.startsWith(snapshot);
  }
  if (Array.isArray(snapshot)) {
    return (
      Array.isArray(current) &&
      snapshot.length <= current.length &&
      snapshot.every((value: unknown, index: number): boolean =>
        isJsonPrefix(value, current[index]),
      )
    );
  }
  if (typeof snapshot !== "object" || snapshot === null) {
    return Object.is(snapshot, current);
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    return false;
  }
  const currentRecord = current as Record<string, unknown>;
  return Object.entries(snapshot).every(
    ([key, value]: [string, unknown]): boolean =>
      Object.hasOwn(currentRecord, key) && isJsonPrefix(value, currentRecord[key]),
  );
}

/**
 * 将单个助手消息事件流编码为紧凑、可回放的帧序列。
 *
 * @remarks 事件中的 `partial` 是共享的实时累积对象；编码器为每个内容块记录偏移，避免在消费较早排队的事件时重复回放已可见的增量。每个实例只能编码一条消息流，内容块索引结束后不得再次开始。
 */
export class AssistantMessageFrameEncoder {
  private hasStarted = false;
  private isTerminal = false;
  private readonly blocks = new Map<number, EncoderBlockState>();
  private readonly endedBlocks = new Set<number>();

  /**
   * 将一个助手消息事件编码为帧。
   *
   * @param event - 按流顺序传入的助手消息事件。
   * @returns 对应的紧凑帧；done/error 事件、已被起始快照覆盖的增量、空增量以及尚未追上起始快照的工具调用增量返回 `undefined`。
   * @throws Error 事件顺序非法时抛出，例如终止事件之后仍有事件、重复 start、start 之前出现其他事件、事件类型与内容块类型不符、内容块未开始或重复开始，以及工具参数无法序列化。
   * @remarks 会更新编码器内部的块状态；done 或 error 事件之后编码器进入终止状态。
   */
  encode(event: AssistantMessageEvent): AssistantMessageFrame | undefined {
    if (this.isTerminal) {
      throw new Error(`Assistant message event ${event.type} follows a terminal event`);
    }

    switch (event.type) {
      case "start":
        if (this.hasStarted) {
          throw new Error("Assistant message stream contains more than one start event");
        }
        this.hasStarted = true;
        return { type: "start", partial: cloneStartMessage(event.partial) };
      case "done":
        if (!this.hasStarted) {
          throw new Error("Assistant message done event appears before start");
        }
        this.isTerminal = true;
        return undefined;
      case "error":
        this.isTerminal = true;
        return undefined;
    }

    if (!this.hasStarted) {
      throw new Error(`Assistant message ${event.type} event appears before start`);
    }

    switch (event.type) {
      case "text_start": {
        const content = eventBlock(event);
        if (content.type !== "text") {
          throw new Error(
            `text_start event points to ${content.type} block at index ${event.contentIndex}`,
          );
        }
        this.startBlock(event.contentIndex, {
          kind: "text",
          coveredChars: content.text.length,
          deltaChars: 0,
        });
        return {
          type: "text_start",
          contentIndex: event.contentIndex,
          content: cloneTextContent(content),
        };
      }
      case "text_delta":
        return this.encodeTextDelta(event.contentIndex, event.delta, "text");
      case "text_end": {
        const content = eventBlock(event);
        if (content.type !== "text") {
          throw new Error(
            `text_end event points to ${content.type} block at index ${event.contentIndex}`,
          );
        }
        this.endBlock(event.contentIndex, "text");
        return {
          type: "text_end",
          contentIndex: event.contentIndex,
          content: event.content,
          ...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
        };
      }
      case "thinking_start": {
        const content = eventBlock(event);
        if (content.type !== "thinking") {
          throw new Error(
            `thinking_start event points to ${content.type} block at index ${event.contentIndex}`,
          );
        }
        this.startBlock(event.contentIndex, {
          kind: "thinking",
          coveredChars: content.thinking.length,
          deltaChars: 0,
        });
        return {
          type: "thinking_start",
          contentIndex: event.contentIndex,
          content: cloneThinkingContent(content),
        };
      }
      case "thinking_delta":
        return this.encodeTextDelta(event.contentIndex, event.delta, "thinking");
      case "thinking_end": {
        const content = eventBlock(event);
        if (content.type !== "thinking") {
          throw new Error(
            `thinking_end event points to ${content.type} block at index ${event.contentIndex}`,
          );
        }
        this.endBlock(event.contentIndex, "thinking");
        return {
          type: "thinking_end",
          contentIndex: event.contentIndex,
          content: event.content,
          ...(content.thinkingSignature === undefined
            ? {}
            : { thinkingSignature: content.thinkingSignature }),
          ...(content.redacted === undefined ? {} : { redacted: content.redacted }),
        };
      }
      case "toolcall_start": {
        const content = eventBlock(event);
        if (content.type !== "toolCall") {
          throw new Error(
            `toolcall_start event points to ${content.type} block at index ${event.contentIndex}`,
          );
        }
        const snapshotArguments = serializedArguments(content.arguments);
        const isCaughtUp = snapshotArguments === EMPTY_PARSED_TOOL_ARGUMENTS;
        this.startBlock(event.contentIndex, {
          kind: "toolCall",
          caughtUp: isCaughtUp,
          catchupJson: "",
          snapshotArguments: isCaughtUp ? "" : snapshotArguments,
        });
        return {
          type: "toolcall_start",
          contentIndex: event.contentIndex,
          toolCall: cloneToolCall(content),
        };
      }
      case "toolcall_delta": {
        const state = this.block(event.contentIndex, "toolCall");
        if (state.kind !== "toolCall") {
          throw new Error("Unreachable tool-call encoder state");
        }
        if (state.caughtUp) {
          return event.delta.length === 0
            ? undefined
            : { type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta };
        }
        state.catchupJson += event.delta;
        const argumentsValue = parseStreamingJson<ToolCall["arguments"]>(state.catchupJson);
        if (serializedArguments(argumentsValue) !== state.snapshotArguments) {
          // 旧格式 grammar 调用在 toolcall_start 中携带初始输入，但 JSON 增量流仍从空输入开始。因此其解析参数可以扩展起始快照，而不必完全一致。
          const snapshotArguments = parseStreamingJson<ToolCall["arguments"]>(
            state.snapshotArguments,
          );
          if (!isJsonPrefix(snapshotArguments, argumentsValue)) {
            return undefined;
          }
        }
        state.caughtUp = true;
        state.snapshotArguments = "";
        const json = state.catchupJson;
        state.catchupJson = "";
        return json.length === 0
          ? undefined
          : { type: "toolcall_checkpoint", contentIndex: event.contentIndex, json };
      }
      case "toolcall_end": {
        const content = eventBlock(event);
        if (content.type !== "toolCall") {
          throw new Error(
            `toolcall_end event points to ${content.type} block at index ${event.contentIndex}`,
          );
        }
        if (event.toolCall.type !== "toolCall") {
          throw new Error(
            `toolcall_end event has invalid tool call at index ${event.contentIndex}`,
          );
        }
        this.endBlock(event.contentIndex, "toolCall");
        return {
          type: "toolcall_end",
          contentIndex: event.contentIndex,
          id: event.toolCall.id,
          name: event.toolCall.name,
          arguments: structuredClone(event.toolCall.arguments),
          ...(event.toolCall.namespace === undefined
            ? {}
            : { namespace: event.toolCall.namespace }),
        };
      }
    }
  }

  /**
   * 登记一个新开始的内容块状态。
   *
   * @param contentIndex - 内容块索引。
   * @param state - 该块的初始编码状态。
   * @throws Error 索引非法或该索引的块已开始、已结束时抛出。
   */
  private startBlock(contentIndex: number, state: EncoderBlockState): void {
    assertContentIndex(contentIndex);
    if (this.blocks.has(contentIndex) || this.endedBlocks.has(contentIndex)) {
      throw new Error(`Assistant message block ${contentIndex} starts more than once`);
    }
    this.blocks.set(contentIndex, state);
  }

  /**
   * 获取已开始且类型匹配的内容块编码状态。
   *
   * @param contentIndex - 内容块索引。
   * @param kind - 期望的块类型。
   * @returns 该块当前的编码状态（可变引用）。
   * @throws Error 索引非法、块未开始或类型不匹配时抛出。
   */
  private block(contentIndex: number, kind: EncoderBlockState["kind"]): EncoderBlockState {
    assertContentIndex(contentIndex);
    const state = this.blocks.get(contentIndex);
    if (state === undefined) {
      throw new Error(`Assistant message ${kind} block ${contentIndex} has not started`);
    }
    if (state.kind !== kind) {
      throw new Error(`Assistant message block ${contentIndex} is ${state.kind}, not ${kind}`);
    }
    return state;
  }

  /**
   * 校验并移除已结束内容块的活跃编码状态，保留索引以拒绝重复开始。
   *
   * @param contentIndex - 内容块索引。
   * @param kind - 期望的块类型。
   * @throws Error 索引非法、块未开始或类型不匹配时抛出。
   */
  private endBlock(contentIndex: number, kind: EncoderBlockState["kind"]): void {
    this.block(contentIndex, kind);
    this.blocks.delete(contentIndex);
    this.endedBlocks.add(contentIndex);
  }

  /**
   * 编码文本或思考增量，跳过已被起始快照覆盖的部分。
   *
   * @param contentIndex - 内容块索引。
   * @param delta - 本次增量文本。
   * @param kind - 块类型，决定输出 text_delta 还是 thinking_delta 帧。
   * @returns 仅包含未覆盖部分的增量帧；增量完全被起始快照覆盖时返回 `undefined`。
   * @throws Error 块未开始或类型不匹配时抛出。
   */
  private encodeTextDelta(
    contentIndex: number,
    delta: string,
    kind: "text" | "thinking",
  ): AssistantMessageFrame | undefined {
    const state = this.block(contentIndex, kind);
    if (state.kind === "toolCall") {
      throw new Error("Unreachable text encoder state");
    }
    const deltaStart = state.deltaChars;
    state.deltaChars += delta.length;
    const covered = Math.max(0, state.coveredChars - deltaStart);
    if (covered >= delta.length) {
      return undefined;
    }
    const uncovered = covered === 0 ? delta : delta.slice(covered);
    return kind === "text"
      ? { type: "text_delta", contentIndex, delta: uncovered }
      : { type: "thinking_delta", contentIndex, delta: uncovered };
  }
}

/**
 * 在回放消息末尾追加新内容块并登记其回放状态。
 *
 * @param message - 正在重建的助手消息，会被原地修改。
 * @param states - 内容块索引到回放状态的映射，会被原地修改。
 * @param contentIndex - 新块的索引，必须等于当前内容块数量。
 * @param block - 新块的初始内容，追加前会深拷贝。
 * @param state - 新块的初始回放状态。
 * @throws Error 索引非法、已存在或会留下空洞时抛出。
 */
function appendBlock(
  message: AssistantMessage,
  states: Map<number, ReducerBlockState>,
  contentIndex: number,
  block: TextContent | ThinkingContent | ToolCall,
  state: ReducerBlockState,
): void {
  assertContentIndex(contentIndex);
  if (contentIndex !== message.content.length) {
    const reason = contentIndex < message.content.length ? "already exists" : "would leave a gap";
    throw new Error(`Cannot start assistant message block at index ${contentIndex}: ${reason}`);
  }
  message.content.push(structuredClone(block));
  states.set(contentIndex, state);
}

/**
 * 获取已开始、未结束且类型匹配的内容块及其回放状态。
 *
 * @param message - 正在重建的助手消息。
 * @param states - 内容块索引到回放状态的映射。
 * @param contentIndex - 内容块索引。
 * @param expectedKind - 期望的块类型。
 * @param frameType - 当前帧类型，用于错误信息。
 * @returns 内容块与回放状态的可变引用。
 * @throws Error 索引非法、块未开始、类型不匹配或块已结束时抛出。
 */
function activeBlock(
  message: AssistantMessage,
  states: Map<number, ReducerBlockState>,
  contentIndex: number,
  expectedKind: ReducerBlockState["kind"],
  frameType: AssistantMessageFrame["type"],
): { block: TextContent | ThinkingContent | ToolCall; state: ReducerBlockState } {
  assertContentIndex(contentIndex);
  const state = states.get(contentIndex);
  const block = message.content[contentIndex];
  if (!state || !block) {
    throw new Error(`${frameType} frame has no started block at index ${contentIndex}`);
  }
  if (state.kind !== expectedKind || block.type !== expectedKind) {
    throw new Error(
      `${frameType} frame expected ${expectedKind} block at index ${contentIndex}, found ${block.type}`,
    );
  }
  if (state.ended) {
    throw new Error(`${frameType} frame follows the end of block at index ${contentIndex}`);
  }
  return { block, state };
}

/**
 * 回放紧凑帧序列，重建助手消息。
 *
 * @param frames - 由 {@link AssistantMessageFrameEncoder} 产生的帧序列。
 * @returns 重建后的助手消息；序列中不含 start 帧时返回 `undefined`。
 * @throws Error 帧序列非法时抛出，例如存在多个 start 帧、start 帧之前出现其他帧、块索引非法或重复、帧类型与块类型不符、块结束后仍有帧。
 * @remarks 不修改传入的帧；未结束的工具调用块会根据已累积的 JSON 增量以流式解析方式补全参数。终止状态不在帧中，需另行持久化。
 */
export function reduceAssistantMessageFrames(
  frames: Iterable<AssistantMessageFrame>,
): AssistantMessage | undefined {
  let message: AssistantMessage | undefined;
  let frameBeforeStart: AssistantMessageFrame["type"] | undefined;
  const states = new Map<number, ReducerBlockState>();

  for (const frame of frames) {
    if (frame.type === "start") {
      if (message) {
        throw new Error("Assistant message frame sequence contains more than one start frame");
      }
      if (frameBeforeStart !== undefined) {
        throw new Error(`${frameBeforeStart} frame appears before the start frame`);
      }
      message = structuredClone(frame.partial);
      continue;
    }
    if (!message) {
      frameBeforeStart ??= frame.type;
      continue;
    }

    switch (frame.type) {
      case "text_start":
        if (frame.content.type !== "text") {
          throw new Error(`text_start frame contains ${frame.content.type} content`);
        }
        appendBlock(message, states, frame.contentIndex, frame.content, {
          kind: "text",
          ended: false,
        });
        break;
      case "text_delta": {
        const { block } = activeBlock(message, states, frame.contentIndex, "text", frame.type);
        if (block.type !== "text") {
          throw new Error("Unreachable text frame state");
        }
        block.text += frame.delta;
        break;
      }
      case "text_end": {
        const { block, state } = activeBlock(
          message,
          states,
          frame.contentIndex,
          "text",
          frame.type,
        );
        if (block.type !== "text") {
          throw new Error("Unreachable text frame state");
        }
        block.text = frame.content;
        delete block.textSignature;
        if (frame.textSignature !== undefined) {
          block.textSignature = frame.textSignature;
        }
        state.ended = true;
        break;
      }
      case "thinking_start":
        if (frame.content.type !== "thinking") {
          throw new Error(`thinking_start frame contains ${frame.content.type} content`);
        }
        appendBlock(message, states, frame.contentIndex, frame.content, {
          kind: "thinking",
          ended: false,
        });
        break;
      case "thinking_delta": {
        const { block } = activeBlock(message, states, frame.contentIndex, "thinking", frame.type);
        if (block.type !== "thinking") {
          throw new Error("Unreachable thinking frame state");
        }
        block.thinking += frame.delta;
        break;
      }
      case "thinking_end": {
        const { block, state } = activeBlock(
          message,
          states,
          frame.contentIndex,
          "thinking",
          frame.type,
        );
        if (block.type !== "thinking") {
          throw new Error("Unreachable thinking frame state");
        }
        block.thinking = frame.content;
        delete block.thinkingSignature;
        delete block.redacted;
        if (frame.thinkingSignature !== undefined) {
          block.thinkingSignature = frame.thinkingSignature;
        }
        if (frame.redacted !== undefined) {
          block.redacted = frame.redacted;
        }
        state.ended = true;
        break;
      }
      case "toolcall_start":
        if (frame.toolCall.type !== "toolCall") {
          throw new Error(`toolcall_start frame contains ${frame.toolCall.type} content`);
        }
        appendBlock(message, states, frame.contentIndex, frame.toolCall, {
          kind: "toolCall",
          ended: false,
          json: "",
        });
        break;
      case "toolcall_checkpoint": {
        const { block, state } = activeBlock(
          message,
          states,
          frame.contentIndex,
          "toolCall",
          frame.type,
        );
        if (block.type !== "toolCall" || state.kind !== "toolCall") {
          throw new Error("Unreachable tool-call checkpoint state");
        }
        state.json = frame.json;
        block.arguments = parseStreamingJson<ToolCall["arguments"]>(frame.json);
        break;
      }
      case "toolcall_delta": {
        const { block, state } = activeBlock(
          message,
          states,
          frame.contentIndex,
          "toolCall",
          frame.type,
        );
        if (block.type !== "toolCall" || state.kind !== "toolCall") {
          throw new Error("Unreachable tool-call frame state");
        }
        state.json += frame.delta;
        break;
      }
      case "toolcall_end": {
        const { block, state } = activeBlock(
          message,
          states,
          frame.contentIndex,
          "toolCall",
          frame.type,
        );
        if (block.type !== "toolCall") {
          throw new Error("Unreachable tool-call frame state");
        }
        block.id = frame.id;
        block.name = frame.name;
        block.arguments = structuredClone(frame.arguments);
        delete block.namespace;
        if (frame.namespace !== undefined) {
          block.namespace = frame.namespace;
        }
        state.ended = true;
        break;
      }
    }
  }

  if (!message) {
    return undefined;
  }
  for (const [contentIndex, state] of states) {
    if (state.kind !== "toolCall" || state.ended || state.json.length === 0) {
      continue;
    }
    const block = message.content[contentIndex];
    if (block?.type !== "toolCall") {
      throw new Error("Unreachable tool-call frame state");
    }
    block.arguments = parseStreamingJson<ToolCall["arguments"]>(state.json);
  }

  return message;
}

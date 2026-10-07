import type {
  Context,
  Message,
  SystemMessage,
  Tool,
  ToolReference,
  TranscriptContext,
} from "../types.ts";
import { contentText, getSystemMessageText } from "./text.ts";

export type { TranscriptContext } from "../types.ts";

/**
 * 根据系统提示词和工具集合构建位于对话开头的系统消息。
 *
 * @param systemPrompt - 系统提示词；`undefined` 或空字符串视为无提示词。
 * @param tools - 初始可用工具；`undefined` 或空数组视为无工具。
 * @returns 构建出的系统消息（`timestamp` 固定为 0，仅在有工具时携带 `toolsAdded`）；提示词和工具均为空时返回 `undefined`，使空对话保持为空。
 */
export function createInitialSystemMessage(
  systemPrompt: string | undefined,
  tools: Tool[] | undefined,
): SystemMessage | undefined {
  const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
  const hasTools = tools !== undefined && tools.length > 0;
  if (!hasSystemPrompt && !hasTools) {
    return undefined;
  }
  return {
    role: "system",
    content: systemPrompt ?? "",
    ...(hasTools ? { toolsAdded: tools } : {}),
    timestamp: 0,
  };
}

/**
 * 将 `Context.systemPrompt` 与 `Context.tools` 折叠为开头的系统消息，生成规范化的对话上下文。
 *
 * @param context - 原始请求上下文。
 * @returns 仅包含 `messages` 的 {@link TranscriptContext}；无提示词和工具时消息列表与原上下文相同。
 * @remarks 这是生成 {@link TranscriptContext} 的唯一入口，所有面向提供方的函数都期望接收其结果。
 */
export function normalizeContext(context: Context): TranscriptContext {
  const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
  const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
  return { messages } as TranscriptContext;
}

/**
 * 任意消息列表。回放辅助函数仅读取 role 为 system 的条目，因此代理会话可携带自定义角色而无需预先过滤。
 */
export type TranscriptMessages = readonly { role: string }[];

/**
 * 判断消息是否为系统消息，并收窄为 {@link SystemMessage} 类型。
 *
 * @param message - 任意带 `role` 字段的消息。
 * @returns `role` 为 `"system"` 时返回 `true`。
 */
function isSystemMessage(message: { role: string }): message is SystemMessage {
  return message.role === "system";
}

/**
 * 获取对话开头的系统消息。
 *
 * @param messages - 对话消息列表。
 * @returns 首条消息为系统消息时返回该消息；否则（包括空列表）返回 `undefined`。
 */
export function getInitialSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
  const first = messages[0];
  return first && isSystemMessage(first) ? first : undefined;
}

/**
 * 移除开头的系统消息，供在消息列表之外传递提示词的 API 使用。
 *
 * @param messages - 对话消息列表。
 * @returns 去掉首条系统消息后的新数组；首条不是系统消息时原样返回传入的数组。
 */
export function withoutInitialSystemMessage(messages: Message[]): Message[] {
  return getInitialSystemMessage(messages) ? messages.slice(1) : messages;
}

/**
 * 按顺序应用所有系统消息中的工具增删，计算当前可用的工具集合。
 *
 * @param messages - 对话消息列表，仅读取其中的系统消息。
 * @returns 当前可用工具列表，按工具名首次加入的顺序排列；同名工具以最后一次添加的定义为准，无工具时返回空数组。
 * @remarks 同一条系统消息内先处理 `toolsRemoved`，再处理 `toolsAdded`。
 */
export function getCurrentTools(messages: TranscriptMessages): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (!isSystemMessage(message)) {
      continue;
    }
    for (const tool of message.toolsRemoved ?? []) {
      tools.delete(tool.name);
    }
    for (const tool of message.toolsAdded ?? []) {
      tools.set(tool.name, tool);
    }
  }
  return [...tools.values()];
}

/**
 * 回放所有系统消息，合并为一条承载当前提示词与工具的系统消息。
 *
 * @param messages - 对话消息列表，仅读取其中的系统消息。
 * @returns 合并后的系统消息：非空 `content` 以空行拼接，`sections` 按名称覆盖（值为 `null` 时删除），工具通过 {@link getCurrentTools} 解析，`timestamp` 取第一条系统消息的时间戳；既无系统消息又无工具时返回 `undefined`。
 */
export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
  const content: string[] = [];
  const sections = new Map<string, string>();
  let timestamp: number | undefined;
  for (const message of messages) {
    if (!isSystemMessage(message)) {
      continue;
    }
    timestamp ??= message.timestamp;
    const text = contentText(message.content);
    if (text.length > 0) {
      content.push(text);
    }
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) {
        sections.delete(name);
      } else {
        sections.set(name, value);
      }
    }
  }
  const tools = getCurrentTools(messages);
  if (timestamp === undefined && tools.length === 0) {
    return undefined;
  }
  return {
    role: "system",
    content: content.join("\n\n"),
    ...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
    ...(tools.length > 0 ? { toolsAdded: tools } : {}),
    timestamp: timestamp ?? 0,
  };
}

/**
 * 回放所有系统消息后渲染当前系统提示词文本。
 *
 * @param messages - 对话消息列表。
 * @returns 当前系统提示词文本；不存在系统消息时返回空字符串。
 */
export function getCurrentSystemPrompt(messages: TranscriptMessages): string {
  const message = getCurrentSystemMessage(messages);
  return message ? getSystemMessageText(message) : "";
}

/**
 * 为不支持对话中途系统消息的 API 重建对话：回放后的系统消息置于开头，其余系统消息全部移除。
 *
 * @param context - 规范化后的对话上下文。
 * @returns 新的对话上下文；不存在系统消息和工具时仅包含非系统消息。
 */
export function collapseSystemMessages(context: TranscriptContext): TranscriptContext {
  const head = getCurrentSystemMessage(context.messages);
  const messages = context.messages.filter(
    (message: Message): message is Exclude<Message, SystemMessage> => message.role !== "system",
  );
  return { messages: head ? [head, ...messages] : messages } as TranscriptContext;
}

/**
 * 根据模型能力决定是否保留对话中途的系统消息。
 *
 * @param context - 规范化后的对话上下文。
 * @param canUseMidConvoSystemMessages - 模型是否接受对话中途的系统消息；`undefined` 视为不接受。
 * @returns 支持时原样返回 `context`；否则返回经 {@link collapseSystemMessages} 合并后的上下文。
 */
export function resolveTranscript(
  context: TranscriptContext,
  canUseMidConvoSystemMessages: boolean | undefined,
): TranscriptContext {
  return canUseMidConvoSystemMessages ? context : collapseSystemMessages(context);
}

/**
 * 去除工具中的可执行字段与仅用于展示的字段，得到用于对话比较或持久化的工具声明。
 *
 * @param tool - 原始工具定义。
 * @returns 仅包含 `name`、`description`、深拷贝的 `parameters` 以及（存在时）`constrainedSampling` 的新工具对象。
 * @remarks `parameters` 经过 JSON 往返复制，会丢弃 symbol 键和值为 `undefined` 的字段。
 */
export function toToolDeclaration(tool: Tool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
    ...(tool.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: tool.constrainedSampling }),
  };
}

/**
 * 判断两个工具向模型声明的接口是否相同。
 *
 * @param left - 待比较的第一个工具。
 * @param right - 待比较的第二个工具。
 * @returns 两者经 {@link toToolDeclaration} 处理后的序列化结果完全一致时返回 `true`。
 * @remarks 双方先经过 {@link toToolDeclaration}：其 JSON 往返会丢弃 typebox 的 symbol 键和 `undefined` 字段，并以相同键顺序构建对象，因此比较序列化结果是精确的，同时避免在浏览器安全的包中引入深比较依赖。
 */
export function declarationsEqual(left: Tool, right: Tool): boolean {
  return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

export interface ToolStateChanges {
  toolsAdded: Tool[];
  toolsRemoved: ToolReference[];
}

/**
 * 比较前后两份完整的工具状态，计算工具的增删变化。
 *
 * @param previous - 变更前的工具列表。
 * @param current - 变更后的工具列表。
 * @returns 新增工具声明（按 `current` 顺序，经 {@link toToolDeclaration} 处理）与移除工具引用（按 `previous` 顺序）；无变化时两个数组均为空。
 * @remarks 定义发生变化的同名工具同时出现在移除和新增列表中。
 */
export function getToolStateChanges(
  previous: readonly Tool[],
  current: readonly Tool[],
): ToolStateChanges {
  const previousTools = new Map(previous.map((tool: Tool): [string, Tool] => [tool.name, tool]));
  const currentTools = new Map(current.map((tool: Tool): [string, Tool] => [tool.name, tool]));
  return {
    toolsAdded: current
      .filter((tool: Tool): boolean => {
        const previousTool = previousTools.get(tool.name);
        return previousTool === undefined || !declarationsEqual(previousTool, tool);
      })
      .map(toToolDeclaration),
    toolsRemoved: previous
      .filter((tool: Tool): boolean => {
        const currentTool = currentTools.get(tool.name);
        return currentTool === undefined || !declarationsEqual(tool, currentTool);
      })
      .map((tool: Tool): { name: string } => ({ name: tool.name })),
  };
}

/**
 * 收集对话工具状态中声明过的所有工具定义。
 *
 * @param messages - 对话消息列表，仅读取其中的系统消息。
 * @returns 工具定义列表，按工具名首次声明的顺序排列，同名工具取最后一次声明的定义；不考虑 `toolsRemoved`，无声明时返回空数组。
 */
export function getDeclaredTools(messages: TranscriptMessages): Tool[] {
  const definitions = new Map<string, Tool>();
  for (const message of messages) {
    if (!isSystemMessage(message)) {
      continue;
    }
    for (const tool of message.toolsAdded ?? []) {
      definitions.set(tool.name, tool);
    }
  }
  return [...definitions.values()];
}

/**
 * 判断是否存在同名工具以不同定义被重复声明的情况。只能按名称引用已声明工具的传输层无法回放此类历史。
 *
 * @param messages - 对话消息列表，仅读取其中的系统消息。
 * @returns 存在同名但定义不同的重复声明时返回 `true`；否则返回 `false`。
 * @deprecated 内置传输层已不再需要该函数：Anthropic 使用内联 `tool_definition` 块表达重定义。保留仅为 API 兼容，将在未来版本移除。
 */
export function hasToolRedefinitions(messages: TranscriptMessages): boolean {
  const declared = new Map<string, Tool>();
  for (const message of messages) {
    if (!isSystemMessage(message)) {
      continue;
    }
    for (const tool of message.toolsAdded ?? []) {
      const previous = declared.get(tool.name);
      if (previous !== undefined && !declarationsEqual(previous, tool)) {
        return true;
      }
      declared.set(tool.name, tool);
    }
  }
  return false;
}

/**
 * 判断工具历史中是否包含仅支持追加的传输层无法回放的变更。
 *
 * @param messages - 对话消息列表，仅读取其中的系统消息。
 * @returns 存在任何工具移除或同名工具再次声明（无论定义是否相同）时返回 `true`；否则返回 `false`。
 */
export function hasNonAdditiveToolChanges(messages: TranscriptMessages): boolean {
  const declared = new Set<string>();
  for (const message of messages) {
    if (!isSystemMessage(message)) {
      continue;
    }
    if ((message.toolsRemoved?.length ?? 0) > 0) {
      return true;
    }
    for (const tool of message.toolsAdded ?? []) {
      if (declared.has(tool.name)) {
        return true;
      }
      declared.add(tool.name);
    }
  }
  return false;
}

export interface TranscriptTools {
  /**
   * 通过请求顶层字段发送的工具。
   */
  requestTools: Tool[];
  /**
   * 后续系统消息是否携带 toolsAdded 作为原位增量。为 false 时，requestTools 已包含全部当前工具。
   */
  isAnchoringAdditions: boolean;
}

/**
 * 在请求顶层工具字段与系统消息原位追加之间分配工具声明。
 *
 * @param messages - 对话消息列表。
 * @param canAnchorToolAdditions - 传输层是否支持在系统消息处原位追加工具。
 * @returns 工具分配结果：可原位追加时 `requestTools` 为开头系统消息的 `toolsAdded`（不存在时为空数组）且 `isAnchoringAdditions` 为 `true`；否则 `requestTools` 为当前完整工具集合且 `isAnchoringAdditions` 为 `false`。
 * @remarks 原位追加仅在历史中没有工具移除或同名重复声明时可用，参见 {@link hasNonAdditiveToolChanges}。
 */
export function resolveTranscriptTools(
  messages: TranscriptMessages,
  canAnchorToolAdditions: boolean,
): TranscriptTools {
  const shouldAnchorAdditions = canAnchorToolAdditions && !hasNonAdditiveToolChanges(messages);
  return {
    requestTools: shouldAnchorAdditions
      ? (getInitialSystemMessage(messages)?.toolsAdded ?? [])
      : getCurrentTools(messages),
    isAnchoringAdditions: shouldAnchorAdditions,
  };
}

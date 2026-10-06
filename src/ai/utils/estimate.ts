import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  TranscriptContext,
  Usage,
} from "../types.ts";
import { getSystemMessageText } from "./text.ts";

export interface ContextUsageEstimate {
  /**
   * 估算的上下文 token 总数。
   */
  tokens: number;
  /**
   * 最近一条适用的助手用量记录报告的 token 数。
   */
  usageTokens: number;
  /**
   * 最近一条适用的助手用量记录之后的估算 token 数。
   */
  trailingTokens: number;
  /**
   * 提供适用用量记录的消息索引；不存在时为 null。
   */
  lastUsageIndex: number | null;
}

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

/**
 * 根据助手用量计算上下文占用的 token 总数。
 * @param usage - 助手消息报告的用量。
 * @returns `totalTokens` 非零时直接返回；否则返回输入、输出、缓存读取与缓存写入 token 之和。
 */
function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * 安全地将任意值序列化为 JSON 字符串，用于字符数估算。
 * @param value - 待序列化的值。
 * @returns JSON 字符串；序列化结果为 undefined 时返回 `"undefined"`，序列化失败时返回 `"[unserializable]"`。
 */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

/**
 * 估算文本与图片内容的字符数。
 * @param content - 字符串内容或文本/图片内容块数组。
 * @returns 文本按实际长度计算，每张图片按固定的 4800 个字符计算。
 */
function estimateTextAndImageContentChars(
  content: string | Array<TextContent | ImageContent>,
): number {
  if (typeof content === "string") {
    return content.length;
  }

  let chars = 0;
  for (const block of content) {
    chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/**
 * 按每 4 个字符约 1 个 token 估算文本的 token 数量。
 * @param text - 待估算的文本。
 * @returns 向上取整后的估算 token 数；空字符串返回 0。
 */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * 估算文本与图片内容的 token 数量。
 * @param content - 字符串内容或文本/图片内容块数组。
 * @returns 向上取整后的估算 token 数；每张图片按 4800 个字符（约 1200 token）计算。
 */
function estimateTextAndImageContentTokens(
  content: string | Array<TextContent | ImageContent>,
): number {
  return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

/**
 * 估算单条消息的 token 数量。
 * @param message - 待估算的消息。
 * @returns 向上取整后的估算 token 数。
 * @remarks 系统消息计入渲染后的提示词文本及新增/移除工具定义的 JSON；用户与工具结果消息计入文本和图片；助手消息计入文本、思考内容以及工具调用名称与参数 JSON。
 */
export function estimateMessageTokens(message: Message): number {
  let chars = 0;

  if (message.role === "system") {
    return (
      estimateTextTokens(getSystemMessageText(message)) +
      estimateToolsTokens(message.toolsAdded) +
      estimateToolsTokens(message.toolsRemoved)
    );
  }
  if (message.role === "user") {
    return estimateTextAndImageContentTokens(message.content);
  }
  if (message.role === "toolResult") {
    return estimateTextAndImageContentTokens(message.content);
  }

  for (const block of message.content) {
    if (block.type === "text") {
      chars += block.text.length;
    } else if (block.type === "thinking") {
      chars += block.thinking.length;
    } else {
      chars += block.name.length + safeJsonStringify(block.arguments).length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 查找能够描述当前会话前缀的最近一次有效助手用量。
 * @param messages - 按会话顺序排列的消息。
 * @returns 用量及其消息索引；不存在有效用量时返回 undefined。
 */
function getLastAssistantUsageInfo(
  messages: readonly Message[],
): { usage: Usage; index: number } | undefined {
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  let usageInfo: { usage: Usage; index: number } | undefined;

  for (const [i, message] of messages.entries()) {
    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      // 此响应之后插入了更新的前缀消息，例如压缩摘要，因此旧用量无法描述当前前缀。
      const isUsageApplicableToPrefix = assistant.timestamp >= latestPrefixTimestamp;
      if (
        isUsageApplicableToPrefix &&
        assistant.stopReason !== "aborted" &&
        assistant.stopReason !== "error" &&
        calculateContextTokens(assistant.usage) > 0
      ) {
        usageInfo = { usage: assistant.usage, index: i };
      }
    }
    latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
  }

  return usageInfo;
}

/**
 * 根据最近有效用量和后续消息估算会话上下文的 token 数量。
 * @param context - 会话上下文或只读消息数组。
 * @returns 总估算量、有效用量、后续估算量及用量消息索引；空会话返回零值和 null 索引。
 * @remarks 无有效用量时逐条估算全部消息。
 */
export function estimateContextTokens(
  context: TranscriptContext | readonly Message[],
): ContextUsageEstimate {
  const messages = "messages" in context ? context.messages : context;
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (usageInfo) {
    const usageTokens = calculateContextTokens(usageInfo.usage);
    let trailingTokens = 0;
    for (const message of messages.slice(usageInfo.index + 1)) {
      trailingTokens += estimateMessageTokens(message);
    }
    return {
      tokens: usageTokens + trailingTokens,
      usageTokens,
      trailingTokens,
      lastUsageIndex: usageInfo.index,
    };
  }

  let tokens = 0;
  for (const message of messages) {
    tokens += estimateMessageTokens(message);
  }
  return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * 估算工具定义列表序列化为 JSON 后的 token 数量。
 * @param tools - 工具定义列表。
 * @returns 估算 token 数；列表为空或未提供时返回 0。
 */
function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
  if (!tools || tools.length === 0) {
    return 0;
  }
  return estimateTextTokens(safeJsonStringify(tools));
}

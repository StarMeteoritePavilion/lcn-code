import type {
  ImageContent,
  SystemMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "../types.ts";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/**
 * 提取消息内容中的文本并拼接为单个字符串。
 * @param content - 字符串内容或内容块数组。
 * @param separator - 拼接多个文本块时使用的分隔符，默认为换行符。
 * @returns 字符串内容原样返回；内容块数组仅拼接 `text` 类型块的文本，不含文本块时返回空字符串。
 */
export function contentText(
  content: string | readonly Content[],
  separator: string = "\n",
): string {
  if (typeof content === "string") {
    return content;
  }
  const textBlocks = content.filter(
    (block: Content): block is TextContent => block.type === "text",
  );
  return textBlocks.map((block: TextContent): string => block.text).join(separator);
}

/**
 * 将系统消息渲染为完整提示词：先输出正文，再依次输出各分节内容。
 * @param message - 待渲染的系统消息。
 * @returns 以空行分隔的提示词文本；值为 null 的分节和空字符串部分会被跳过。
 */
export function getSystemMessageText(message: SystemMessage): string {
  const parts = [contentText(message.content)];
  for (const text of Object.values(message.sections ?? {})) {
    if (text !== null) {
      parts.push(text);
    }
  }
  return parts.filter((part: string): boolean => part.length > 0).join("\n\n");
}

/**
 * 为支持在对话中途插入系统消息的 API 渲染后续系统消息。
 * @param message - 对话中途出现的系统消息。
 * @returns 以空行分隔的更新文本：非空正文在前，随后为每个分节的更新或移除说明。
 * @remarks 分节变更会带上分节名称，便于模型将其与开头的提示词关联；该措辞仅在请求时生成，可能随版本变化。
 */
export function renderSystemMessageUpdate(message: SystemMessage): string {
  const parts: string[] = [];
  const text = contentText(message.content);
  if (text.length > 0) {
    parts.push(text);
  }
  for (const [name, value] of Object.entries(message.sections ?? {})) {
    parts.push(
      value === null
        ? `Removed system prompt section "${name}".`
        : `Updated system prompt section "${name}":\n\n${value}`,
    );
  }
  return parts.join("\n\n");
}

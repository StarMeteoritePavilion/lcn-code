import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

/**
 * 将内容中的图片块替换为文本占位符，连续的图片只保留一个占位符。
 * @param content - 文本与图片内容块。
 * @param placeholder - 替换图片使用的占位文本。
 * @returns 仅含文本块的新数组；紧跟在与占位符相同的文本块之后的图片不再重复插入占位符。
 */
function replaceImagesWithPlaceholder(
  content: (TextContent | ImageContent)[],
  placeholder: string,
): TextContent[] {
  const result: TextContent[] = [];
  let isPreviousPlaceholder = false;

  for (const block of content) {
    if (block.type === "image") {
      if (!isPreviousPlaceholder) {
        result.push({ type: "text", text: placeholder });
      }
      isPreviousPlaceholder = true;
      continue;
    }

    result.push(block);
    isPreviousPlaceholder = block.text === placeholder;
  }

  return result;
}

/**
 * 当目标模型不支持图片输入时，将用户消息和工具结果中的图片替换为占位文本。
 * @param messages - 待处理的会话消息。
 * @param model - 目标模型；`input` 未声明或包含 `"image"` 时视为支持图片。
 * @returns 模型支持图片时原样返回输入数组；否则返回替换图片后的新数组，原消息不被修改。
 */
function downgradeUnsupportedImages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
): Message[] {
  if (model.input === undefined || model.input.includes("image")) {
    return messages;
  }

  return messages.map((msg: Message): Message => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
      };
    }

    if (msg.role === "toolResult") {
      return {
        ...msg,
        content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
      };
    }

    return msg;
  });
}

/**
 * 转换跨提供商会话内容、工具调用标识符，并补齐未完成工具调用的结果。
 * @param messages - 待转换的会话消息。
 * @param model - 目标模型，决定图片能力和历史消息的兼容处理。
 * @param normalizeToolCallId - 工具调用标识符转换函数，未提供时保留原标识符。
 * @returns 转换后的消息数组；空会话返回空数组。
 * @throws 标识符转换函数抛出的错误会向调用方传播。
 * @remarks 跳过失败或中止的助手消息，为缺少结果的工具调用补充错误结果，并延迟工具流程中的系统消息。
 */
export function transformMessages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
  normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
  // 建立原始工具调用 id 到规范化 id 的映射。
  const toolCallIdMap = new Map<string, string>();
  // 规范化无类型调用方传入的 null 或 undefined 内容，例如自定义工具、手工历史与旧会话文件，使后续代码可以依赖类型约定。
  const normalizedMessages = messages.map((msg: Message): Message =>
    msg.content == null ? { ...msg, content: [] } : msg,
  );
  const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

  // 第一轮转换：不支持的图片降级、思考块处理及工具调用 id 规范化。
  const transformed = imageAwareMessages.map((msg: Message): Message => {
    // 系统与用户消息原样传递。
    if (msg.role === "system" || msg.role === "user") {
      return msg;
    }

    // 处理 toolResult 消息；存在映射时规范化 toolCallId。
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return { ...msg, toolCallId: normalizedId };
      }
      return msg;
    }

    // 检查助手消息是否需要转换。
    if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;
      const isSameModel =
        assistantMsg.baseUrl === model.baseUrl &&
        assistantMsg.api === model.api &&
        assistantMsg.model === model.id;

      const transformedContent = assistantMsg.content.flatMap(
        (
          block: TextContent | ThinkingContent | ToolCall,
        ): AssistantMessage["content"][number] | [] => {
          if (block.type === "thinking") {
            // 已遮蔽的思考是不可解析的加密内容，仅对相同模型有效。跨模型时丢弃，避免 API 错误。
            if (block.redacted) {
              return isSameModel ? block : [];
            }
            // 相同模型保留带签名的思考块以支持回放，即使文本为空也保留，例如 OpenAI 加密推理。
            if (isSameModel && block.thinkingSignature) {
              return block;
            }
            // 跳过空思考块，其余转换为普通文本。
            if (!block.thinking || block.thinking.trim() === "") {
              return [];
            }
            if (isSameModel) {
              return block;
            }
            return {
              type: "text" as const,
              text: block.thinking,
            };
          }

          if (block.type === "text") {
            if (isSameModel) {
              return block;
            }
            return {
              type: "text" as const,
              text: block.text,
            };
          }

          if (block.type === "toolCall") {
            const toolCall = block as ToolCall;
            let normalizedToolCall: ToolCall = toolCall;

            if (!isSameModel && normalizeToolCallId) {
              const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
              if (normalizedId !== toolCall.id) {
                toolCallIdMap.set(toolCall.id, normalizedId);
                normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
              }
            }

            return normalizedToolCall;
          }

          return block;
        },
      );

      return {
        ...assistantMsg,
        content: transformedContent,
      };
    }
    return msg;
  });

  // 第二轮为孤立工具调用补充合成空工具结果，保留思考签名并满足 API 要求。
  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  // 工具调用与结果之间的系统消息延迟到结果之后发送，包括合成结果。系统消息不影响调用记账，避免为稍后才返回结果的调用产生重复结果。
  const heldSystemMessages: Message[] = [];
  /**
   * 为尚未收到结果的待处理工具调用补充错误结果，并输出被暂存的系统消息。
   * @remarks 会向 `result` 追加消息，并重置待处理工具调用、已有结果标识和暂存系统消息。
   */
  const closePendingToolCalls = (): void => {
    if (pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        if (!existingToolResultIds.has(tc.id)) {
          result.push({
            role: "toolResult",
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: "text", text: "No result provided" }],
            isError: true,
            timestamp: Date.now(),
          } as ToolResultMessage);
        }
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
    result.push(...heldSystemMessages);
    heldSystemMessages.length = 0;
  };

  for (const msg of transformed) {
    if (msg.role === "assistant") {
      // 若上一条助手消息仍有孤立工具调用，现在补充合成结果。
      closePendingToolCalls();

      // 完全跳过错误或中断的助手消息。这些未完成轮次可能含没有后续消息的推理或不完整工具调用，回放可能触发 API 错误，例如 OpenAI 的 reasoning without following item；模型应从最后有效状态重试。
      const assistantMsg = msg as AssistantMessage;
      if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
        continue;
      }

      // 记录当前助手消息的工具调用。
      const toolCalls = assistantMsg.content.filter(
        (b: TextContent | ThinkingContent | ToolCall): b is ToolCall => b.type === "toolCall",
      ) as ToolCall[];
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }

      result.push(msg);
    } else if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === "system") {
      if (pendingToolCalls.length > 0) {
        heldSystemMessages.push(msg);
      } else {
        result.push(msg);
      }
    } else if (msg.role === "user") {
      // 新用户轮次会打断工具流程，为孤立调用补充合成结果。
      closePendingToolCalls();
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  // 会话结束时，为尚未解决的工具调用补充合成结果。
  closePendingToolCalls();

  return result;
}

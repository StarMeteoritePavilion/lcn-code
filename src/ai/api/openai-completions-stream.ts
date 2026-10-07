import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { calculateCost } from "../models.ts";
import type {
  AssistantMessage,
  Model,
  StopReason,
  StreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import {
  appendGrammarToolInputJsonDelta,
  type GrammarToolInputJsonBuffer,
} from "./constrained-sampling.ts";
import {
  appendOpenAIReasoningDetail,
  isOpenAIReasoningDetail,
} from "./openai-completions-request.ts";

/**
 * 消费 Chat Completions 原生分片并更新助手内容、用量和内容事件。
 * @param openaiStream - 本次请求的原生分片流。
 * @param output - 本次请求的助手消息，会被原地更新。
 * @param model - 请求模型，用于模型记录和费用计算。
 * @param grammarToolInputProperties - 文法工具名到输入属性名的映射。
 * @param stream - 接收内容 start、delta 和 end 事件的助手事件流。
 * @param onStreamEvent - 每个原生分片解析前执行的回调，未提供时跳过。
 * @returns 正常完成内容块后返回是否收到 finish_reason；终态与取消检查由入口执行。
 * @throws 原生流迭代、事件回调或内容解析失败时回填已有思考签名并原样抛出异常。
 * @remarks 所有缓冲均仅属于本次请求；失败时不删除内容临时字段、不补发内容 end 或公共终止事件。
 */
export async function processCompletionsStream(
  openaiStream: AsyncIterable<ChatCompletionChunk>,
  output: AssistantMessage,
  model: Model<"openai-completions">,
  grammarToolInputProperties: ReadonlyMap<string, string>,
  stream: AssistantMessageEventStream,
  onStreamEvent?: StreamOptions["onStreamEvent"],
): Promise<{ hasFinishReason: boolean }> {
  // reasoning_details 用于回放元数据，不作为用户可见的流式增量。流处理中保存在内存，内容块结束时仅序列化一次。
  let streamedReasoningDetails: Parameters<typeof appendOpenAIReasoningDetail>[0] | undefined;
  /**
   * 将流式收集的 reasoning detail 序列化写入思考块签名。
   * @param block - 需要写入签名的思考块，会被原地修改。
   * @remarks 尚未收到任何 reasoning detail 时保持原签名不变。
   */
  const applyStreamedReasoningDetails = (block: ThinkingContent): void => {
    if (streamedReasoningDetails !== undefined) {
      block.thinkingSignature = JSON.stringify(streamedReasoningDetails);
    }
  };

  interface StreamingToolCallBlock extends ToolCall {
    partialArgs?: string;
    customInput?: {
      property: string;
      jsonBuffer: GrammarToolInputJsonBuffer;
    };
    streamIndex?: number;
  }
  type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
  type StreamingToolCallDelta = {
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
    custom?: { name?: string; input?: string };
  };

  let textBlock: TextContent | null = null;
  let thinkingBlock: ThinkingContent | null = null;
  let hasFinishReason = false;
  const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
  const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
  const blocks = output.content as StreamingBlock[];
  /**
   * 获取内容块在当前助手消息中的索引。
   * @param block - 要定位的内容块。
   * @returns 内容块索引；内容块不存在时为 -1。
   */
  const getContentIndex = (block: StreamingBlock): number => blocks.indexOf(block);
  /**
   * 读取自定义（grammar）工具调用当前已累积的原始输入。
   * @param block - 流式工具调用块。
   * @returns 输入属性对应的字符串值；非自定义工具或值不是字符串时返回空字符串。
   */
  const getCustomToolCallInput = (block: StreamingToolCallBlock): string => {
    const property = block.customInput?.property;
    if (property === undefined) {
      return "";
    }
    const value = block.arguments[property];
    return typeof value === "string" ? value : "";
  };
  /**
   * 更新自定义工具调用的完整输入，并生成对应的 JSON 参数增量。
   * @param block - 流式工具调用块，其 `arguments` 会被替换为最新输入。
   * @param nextInput - 截至目前的完整原始输入。
   * @param shouldClose - 是否结束 JSON 缓冲并输出收尾片段。
   * @returns 本次需要推送的 JSON 参数增量；块不是自定义工具调用时返回 undefined。
   */
  const appendCustomToolCallInput = (
    block: StreamingToolCallBlock,
    nextInput: string,
    shouldClose: boolean,
  ): string | undefined => {
    const customInput = block.customInput;
    if (!customInput) {
      return undefined;
    }
    const delta = appendGrammarToolInputJsonDelta(
      customInput.jsonBuffer,
      customInput.property,
      nextInput,
      shouldClose,
    );
    block.arguments = { [customInput.property]: nextInput };
    return delta;
  };
  /**
   * 完成内容块并推送对应的 end 事件。
   * @param block - 待完成的流式内容块。
   * @remarks 不在输出内容中的块直接忽略；思考块会写入 reasoning detail 签名；工具调用块会解析最终参数并删除流式临时字段。
   */
  const finishBlock = (block: StreamingBlock): void => {
    const contentIndex = getContentIndex(block);
    if (contentIndex === -1) {
      return;
    }
    if (block.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial: output,
      });
    } else if (block.type === "thinking") {
      applyStreamedReasoningDetails(block);
      stream.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: output,
      });
    } else if (block.type === "toolCall") {
      if (block.customInput) {
        const delta = appendCustomToolCallInput(block, getCustomToolCallInput(block), true);
        if (delta !== undefined) {
          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta,
            partial: output,
          });
        }
      } else {
        block.arguments = parseStreamingJson(block.partialArgs);
      }
      // 就地完成工具参数解析并删除临时缓冲区，回放仅保留已解析参数。
      delete block.partialArgs;
      delete block.customInput;
      delete block.streamIndex;
      stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: block,
        partial: output,
      });
    }
  };
  /**
   * 获取当前文本块，不存在时创建并推送 text_start 事件。
   * @returns 当前流中唯一的文本块。
   */
  const ensureTextBlock = (): TextContent => {
    if (!textBlock) {
      textBlock = { type: "text", text: "" };
      blocks.push(textBlock);
      stream.push({
        type: "text_start",
        contentIndex: getContentIndex(textBlock),
        partial: output,
      });
    }
    return textBlock;
  };
  /**
   * 获取当前思考块，不存在时创建并推送 thinking_start 事件。
   * @param thinkingSignature - 新建思考块时使用的签名（通常为推理字段名）；思考块已存在时忽略。
   * @returns 当前流中唯一的思考块。
   */
  const ensureThinkingBlock = (thinkingSignature: string): ThinkingContent => {
    if (!thinkingBlock) {
      thinkingBlock = {
        type: "thinking",
        thinking: "",
        thinkingSignature,
      };
      blocks.push(thinkingBlock);
      stream.push({
        type: "thinking_start",
        contentIndex: getContentIndex(thinkingBlock),
        partial: output,
      });
    }
    return thinkingBlock;
  };
  /**
   * 按流索引或调用 ID 查找工具调用块，不存在时创建并推送 toolcall_start 事件。
   * @param toolCall - 流式工具调用增量。
   * @returns 与该增量对应的工具调用块。
   * @remarks 会补登记索引与 ID 映射、补全缺失的工具名；收到自定义工具增量且块尚未初始化自定义输入时，会切换为自定义输入模式。
   */
  const ensureToolCallBlock = (toolCall: StreamingToolCallDelta): StreamingToolCallBlock => {
    const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
    const name = toolCall.function?.name ?? toolCall.custom?.name ?? "";
    let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
    if (!block && toolCall.id) {
      block = toolCallBlocksById.get(toolCall.id);
    }
    if (!block) {
      // 未知工具无法提供输入属性名时，以 input 保存流式输入。
      const customInputProperty =
        toolCall.custom && !toolCall.function
          ? (grammarToolInputProperties.get(name) ?? "input")
          : undefined;
      const hasCustomInput = customInputProperty !== undefined;
      block = {
        type: "toolCall",
        id: toolCall.id || "",
        name,
        arguments: hasCustomInput ? { [customInputProperty]: "" } : {},
        partialArgs: hasCustomInput ? undefined : "",
        customInput: hasCustomInput
          ? {
              property: customInputProperty,
              jsonBuffer: { input: "", started: false, closed: false },
            }
          : undefined,
        streamIndex,
      };
      if (streamIndex !== undefined) {
        toolCallBlocksByIndex.set(streamIndex, block);
      }
      if (toolCall.id) {
        toolCallBlocksById.set(toolCall.id, block);
      }
      blocks.push(block);
      stream.push({
        type: "toolcall_start",
        contentIndex: getContentIndex(block),
        partial: output,
      });
    }
    if (streamIndex !== undefined && block.streamIndex === undefined) {
      block.streamIndex = streamIndex;
      toolCallBlocksByIndex.set(streamIndex, block);
    }
    if (toolCall.id) {
      toolCallBlocksById.set(toolCall.id, block);
    }
    if (!block.name && name) {
      block.name = name;
    }
    if (toolCall.custom && !toolCall.function && !block.customInput) {
      const customInputProperty = grammarToolInputProperties.get(block.name) ?? "input";
      block.arguments = { [customInputProperty]: "" };
      block.customInput = {
        property: customInputProperty,
        jsonBuffer: { input: "", started: false, closed: false },
      };
      delete block.partialArgs;
    }
    return block;
  };

  try {
    for await (const chunk of openaiStream) {
      await onStreamEvent?.(chunk, model);
      if (!chunk || typeof chunk !== "object") {
        continue;
      }

      // OpenAI 将 ChatCompletionChunk.id 定义为唯一的补全标识符，同一流式补全的每个分块均携带相同 id。
      output.responseId ||= chunk.id;
      if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
        output.responseModel ||= chunk.model;
      }
      if (chunk.usage) {
        output.usage = parseChunkUsage(chunk.usage, model);
      }

      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (!choice) {
        continue;
      }

      // 兼容端点可能将 usage 放在 choice 上，而不是分块顶层。
      const choiceUsage = (choice as { usage?: Parameters<typeof parseChunkUsage>[0] }).usage;
      if (!chunk.usage && choiceUsage) {
        output.usage = parseChunkUsage(choiceUsage, model);
      }

      if (choice.finish_reason) {
        output.rawStopReason = choice.finish_reason;
        const finishReasonResult = mapStopReason(choice.finish_reason);
        output.stopReason = finishReasonResult.stopReason;
        if (finishReasonResult.errorMessage) {
          output.errorMessage = finishReasonResult.errorMessage;
        }
        hasFinishReason = true;
      }

      if (choice.delta) {
        if (
          choice.delta.content !== null &&
          choice.delta.content !== undefined &&
          choice.delta.content.length > 0
        ) {
          const block = ensureTextBlock();
          block.text += choice.delta.content;
          stream.push({
            type: "text_delta",
            contentIndex: getContentIndex(block),
            delta: choice.delta.content,
            partial: output,
          });
        }

        // 部分端点通过 reasoning_content（llama.cpp）或 reasoning（其他 OpenAI 兼容端点）返回推理文本。采用第一个非空字段，避免重复；例如 chutes.ai 会同时返回内容相同的两个字段。
        const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
        const deltaFields = choice.delta as Record<string, unknown>;
        let foundReasoningField: string | null = null;
        for (const field of reasoningFields) {
          const value = deltaFields[field];
          if (typeof value === "string" && value.length > 0) {
            foundReasoningField = field;
            break;
          }
        }

        if (foundReasoningField) {
          const delta = deltaFields[foundReasoningField];
          if (typeof delta === "string" && delta.length > 0) {
            const block = ensureThinkingBlock(foundReasoningField);
            block.thinking += delta;
            stream.push({
              type: "thinking_delta",
              contentIndex: getContentIndex(block),
              delta,
              partial: output,
            });
          }
        }

        if (choice?.delta?.tool_calls) {
          for (const toolCall of choice.delta.tool_calls as StreamingToolCallDelta[]) {
            const block = ensureToolCallBlock(toolCall);
            if (!block.id && toolCall.id) {
              block.id = toolCall.id;
              toolCallBlocksById.set(toolCall.id, block);
            }
            let delta = "";
            if (toolCall.function?.arguments) {
              delta = toolCall.function.arguments;
              block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
              block.arguments = parseStreamingJson(block.partialArgs);
            } else if (toolCall.custom?.input) {
              const nextInput = getCustomToolCallInput(block) + toolCall.custom.input;
              delta = appendCustomToolCallInput(block, nextInput, false) ?? "";
            }
            stream.push({
              type: "toolcall_delta",
              contentIndex: getContentIndex(block),
              delta,
              partial: output,
            });
          }
        }

        const reasoningDetails = (choice.delta as { reasoning_details?: unknown })
          .reasoning_details;
        if (Array.isArray(reasoningDetails)) {
          for (const detail of reasoningDetails) {
            if (!isOpenAIReasoningDetail(detail)) {
              continue;
            }
            ensureThinkingBlock("");
            streamedReasoningDetails ??= [];
            // 提供商回放数据保存在现有签名字段中。OpenRouter 以增量形式发送 reasoning_details：连续文本或摘要增量合并为逻辑条目，加密条目保持独立且不解析。
            appendOpenAIReasoningDetail(streamedReasoningDetails, detail);
          }
        }
      }
    }

    for (const block of blocks) {
      finishBlock(block);
    }
    return { hasFinishReason };
  } catch (error) {
    for (const block of output.content) {
      if (block.type === "thinking") {
        applyStreamedReasoningDetails(block);
      }
    }
    throw error;
  }
}

/**
 * 将端点返回的 usage 转换为统一的用量统计并计算费用。
 * @param rawUsage - 端点返回的原始 usage，缓存命中字段可能位于不同位置。
 * @param model - 用于计算费用的模型。
 * @returns 统一格式的用量；`input` 为扣除缓存读取与写入后的非负提示 token 数，`output` 已包含推理 token。
 * @remarks 缓存读取依次取 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、`cached_tokens`。
 */
function parseChunkUsage(
  rawUsage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  },
  model: Model<"openai-completions">,
): AssistantMessage["usage"] {
  const promptTokens = rawUsage.prompt_tokens || 0;
  const cacheReadTokens =
    rawUsage.prompt_tokens_details?.cached_tokens ??
    rawUsage.prompt_cache_hit_tokens ??
    rawUsage.cached_tokens ??
    0;
  const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

  // 遵循 OpenAI/OpenRouter 的缓存语义：cached_tokens 是缓存读取命中数。OpenAI/OpenRouter 使用 prompt_tokens_details.cached_tokens，DeepSeek 使用 prompt_cache_hit_tokens，Kimi 在最终用量分块的顶层 usage.cached_tokens 中返回该值。OpenAI 未定义或发送 cache_write_tokens，OpenRouter 兼容提供商可将其作为独立写入数；对应验证见 https://github.com/OpenRouterTeam/ai-sdk-provider/pull/409 。不能从 cached_tokens 扣除写入数，否则会低估符合约定的提供商用量；DS4 也遵循该约定，见 https://github.com/antirez/ds4/pull/29 。
  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  // OpenAI 的 completion_tokens 已包含 reasoning_tokens。
  const outputTokens = rawUsage.completion_tokens || 0;
  const usage: AssistantMessage["usage"] = {
    input,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
    totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

/**
 * 将端点的 finish_reason 映射为统一停止原因。
 * @param reason - 端点返回的 finish_reason。
 * @returns 映射后的停止原因；`content_filter`、`network_error` 及未知值映射为 `error` 并附带错误信息；null 视为 `stop`。
 */
function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
  stopReason: StopReason;
  errorMessage?: string;
} {
  if (reason === null) {
    return { stopReason: "stop" };
  }
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Endpoint finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Endpoint finish_reason: network_error" };
    default:
      return {
        stopReason: "error",
        errorMessage: `Endpoint finish_reason: ${reason}`,
      };
  }
}

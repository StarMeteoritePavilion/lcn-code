import type OpenAI from "openai";
import type {
  ResponseOutputItem,
  ResponseOutputRefusal,
  ResponseOutputText,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
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
import { encodeTextSignatureV1 } from "./openai-responses-request.ts";

interface OpenAIResponsesStreamOptions {
  onStreamEvent?: StreamOptions["onStreamEvent"];
  onProviderStreamEvent?: StreamOptions["onProviderStreamEvent"];
  grammarToolInputProperties?: ReadonlyMap<string, string>;
  serviceTier?: string | null;
}

/**
 * 计算服务等级对应的费用倍率。
 * @param model - 用于区分特殊定价的模型。
 * @param serviceTier - 服务等级。
 * @returns `flex` 为 0.5；`priority` 或 `fast` 时 gpt-5.5 为 2.5、其他模型为 2；其余为 1。
 */
function getServiceTierCostMultiplier(
  model: Pick<Model<"openai-responses">, "id">,
  serviceTier?: string | null,
): number {
  if (serviceTier === "flex") {
    return 0.5;
  }
  if (serviceTier === "priority" || serviceTier === "fast") {
    return model.id === "gpt-5.5" ? 2.5 : 2;
  }
  return 1;
}

/**
 * 按服务等级倍率调整用量费用。
 * @param usage - 已计算基础费用的用量，会原地修改。
 * @param serviceTier - 实际生效的服务等级。
 * @param model - 用于确定倍率的模型。
 * @remarks 无费用信息或倍率为 1 时不做修改；否则按倍率缩放各项费用并重算总额。
 */
function applyServiceTierPricing(
  usage: NonNullable<AssistantMessage["usage"]>,
  serviceTier: string | null | undefined,
  model: Pick<Model<"openai-responses">, "id">,
): void {
  if (!usage.cost) {
    return;
  }
  const multiplier = getServiceTierCostMultiplier(model, serviceTier);
  if (multiplier === 1) {
    return;
  }
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

type StreamingToolCall = ToolCall & {
  partialJson?: string;
  customInput?: {
    property: string;
    jsonBuffer: GrammarToolInputJsonBuffer;
  };
};

/**
 * 读取自定义工具调用当前累积的输入文本。
 * @param block - 流式中的工具调用块。
 * @returns 输入属性对应的字符串值；无 customInput 或值不是字符串时返回空字符串。
 */
function getCustomToolCallInput(block: StreamingToolCall): string {
  const property = block.customInput?.property;
  if (property === undefined) {
    return "";
  }
  const value = block.arguments[property];
  return typeof value === "string" ? value : "";
}

/**
 * 用新的完整输入更新自定义工具调用的参数，并生成对应的 JSON 参数增量。
 * @param block - 流式中的工具调用块，需带有 customInput 缓冲。
 * @param nextInput - 截至当前的完整输入文本。
 * @param shouldClose - 是否在本次增量后闭合 JSON 参数文本。
 * @returns 本次产生的 JSON 参数增量；块不是自定义工具调用时返回 undefined。
 * @remarks 会原地改写 `block.arguments` 并更新 customInput 的 JSON 缓冲。
 */
function appendCustomToolCallInput(
  block: StreamingToolCall,
  nextInput: string,
  shouldClose: boolean,
): string | undefined {
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
}

type ResponsesOutputSlot =
  | { type: "thinking"; block: ThinkingContent; contentIndex: number }
  | { type: "text"; block: TextContent; contentIndex: number }
  | { type: "toolCall"; block: StreamingToolCall; contentIndex: number };

type ToolCallOutputSlot = Extract<ResponsesOutputSlot, { type: "toolCall" }>;

/**
 * 将 Responses 流事件归并到助手消息，并输出对应的助手消息事件。
 * @param openaiStream - SDK 返回的 Responses 流事件。
 * @param output - 接收文本、思考、工具调用和用量的助手消息，会原地更新。
 * @param stream - 接收转换后事件的助手消息事件流。
 * @param model - 用于回调和费用计算的目标模型。
 * @param options - 原始事件回调、文法工具和服务等级计价配置。
 * @returns 完成表示已处理完整响应；最终完成或错误事件由调用方发送。
 * @throws 提供商报告失败、缺少终态事件、工具调用未完成或回调失败时拒绝。
 */
export async function processResponsesStream(
  openaiStream: AsyncIterable<ResponseStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"openai-responses">,
  options?: OpenAIResponsesStreamOptions,
): Promise<void> {
  let hasSeenTerminalResponseEvent = false;
  const outputSlots = new Map<number, ResponsesOutputSlot>();
  const reasoningBlocksById = new Map<string, ThinkingContent>();
  /**
   * 消息条目处于 `final_answer` 阶段时，将停止原因设为 `stop`。
   * @param item - 待检查的输出条目。
   */
  const applyMessagePhaseStopReason = (item: ResponseOutputItem): void => {
    if (item.type === "message" && item.phase === "final_answer") {
      output.stopReason = "stop";
    }
  };
  /**
   * 获取输出索引对应且类型匹配的槽位。
   * @param outputIndex - 提供商事件中的输出条目索引。
   * @param type - 期望的槽位类型。
   * @returns 类型匹配的槽位；不存在或类型不符时返回 undefined。
   */
  const getSlot = <TType extends ResponsesOutputSlot["type"]>(
    outputIndex: number,
    type: TType,
  ): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
    const slot = outputSlots.get(outputIndex);
    return slot?.type === type
      ? (slot as Extract<ResponsesOutputSlot, { type: TType }>)
      : undefined;
  };
  /**
   * 推送工具调用参数增量事件。
   * @param slot - 增量所属的工具调用槽位。
   * @param delta - 参数增量文本；为 undefined 时不推送。
   */
  const pushToolCallDelta = (slot: ToolCallOutputSlot, delta: string | undefined): void => {
    if (delta === undefined) {
      return;
    }
    stream.push({
      type: "toolcall_delta",
      contentIndex: slot.contentIndex,
      delta,
      partial: output,
    });
  };
  /**
   * 根据输出条目类型创建内容块和槽位，并发送对应的开始事件。
   * @param outputIndex - 提供商事件中的输出条目索引。
   * @param item - 新增的输出条目，支持推理、消息、函数调用和自定义工具调用。
   * @returns 新建的槽位；条目类型不受支持时返回 undefined。
   * @remarks 会向 `output.content` 追加内容块、登记槽位并推送 start 事件；消息条目还会按阶段更新停止原因。
   */
  const createSlot = (
    outputIndex: number,
    item: ResponseOutputItem,
  ): ResponsesOutputSlot | undefined => {
    if (item.type === "reasoning") {
      const block: ThinkingContent = { type: "thinking", thinking: "" };
      output.content.push(block);
      const slot = {
        type: "thinking",
        block,
        contentIndex: output.content.length - 1,
      } satisfies ResponsesOutputSlot;
      outputSlots.set(outputIndex, slot);
      stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    if (item.type === "message") {
      applyMessagePhaseStopReason(item);
      const block: TextContent = { type: "text", text: "" };
      output.content.push(block);
      const slot = {
        type: "text",
        block,
        contentIndex: output.content.length - 1,
      } satisfies ResponsesOutputSlot;
      outputSlots.set(outputIndex, slot);
      stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    if (item.type === "function_call") {
      const block: StreamingToolCall = {
        type: "toolCall",
        id: `${item.call_id}|${item.id}`,
        name: item.name,
        arguments: {},
        ...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
        partialJson: item.arguments || "",
      };
      output.content.push(block);
      const slot = {
        type: "toolCall",
        block,
        contentIndex: output.content.length - 1,
      } satisfies ResponsesOutputSlot;
      outputSlots.set(outputIndex, slot);
      stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    if (item.type === "custom_tool_call") {
      const inputProperty = options?.grammarToolInputProperties?.get(item.name) ?? "input";
      const input = item.input || "";
      const block: StreamingToolCall = {
        type: "toolCall",
        id: `${item.call_id}|${item.id}`,
        name: item.name,
        arguments: { [inputProperty]: input },
        ...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
        customInput: {
          property: inputProperty,
          jsonBuffer: { input: "", isStarted: false, isClosed: false },
        },
      };
      output.content.push(block);
      const slot = {
        type: "toolCall",
        block,
        contentIndex: output.content.length - 1,
      } satisfies ResponsesOutputSlot;
      outputSlots.set(outputIndex, slot);
      stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    return undefined;
  };
  /**
   * 获取输出索引对应的槽位，不存在时按输出条目创建。
   * @param outputIndex - 提供商事件中的输出条目索引。
   * @param item - 用于创建槽位的输出条目。
   * @returns 已有或新建的槽位；条目类型不受支持时返回 undefined。
   */
  const getOrCreateSlot = (
    outputIndex: number,
    item: ResponseOutputItem,
  ): ResponsesOutputSlot | undefined => {
    return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
  };
  // Azure OpenAI 可能在 response.output_item.done 中省略 reasoning.encrypted_content，仅在 response.completed.response.output 返回。通过最终响应补全持久化思考签名，保证 store:false 的无状态多轮回放。见 https://github.com/earendil-works/pi/issues/6409 。
  /**
   * 用终态响应中的加密推理内容回填已记录思考块的签名。
   * @param responseOutput - 终态响应的输出条目列表。
   * @remarks 仅处理已存储签名但缺少 `encrypted_content` 的推理块，会原地改写其 thinkingSignature。
   */
  const backfillReasoningSignatures = (responseOutput: ResponseOutputItem[]): void => {
    for (const item of responseOutput) {
      if (item.type !== "reasoning" || !item.encrypted_content) {
        continue;
      }
      const block = reasoningBlocksById.get(item.id);
      if (!block?.thinkingSignature) {
        continue;
      }

      const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
      if (storedItem.encrypted_content) {
        continue;
      }
      block.thinkingSignature = JSON.stringify({
        ...storedItem,
        encrypted_content: item.encrypted_content,
      });
    }
  };
  /**
   * 处理终态响应：记录响应标识、回填推理签名、计算用量与费用并确定停止原因。
   * @param response - `response.completed` 或 `response.incomplete` 事件携带的完整响应。
   * @remarks 会原地更新 `output` 的 responseId、usage、rawStopReason、stopReason 和 errorMessage；
   * 存在工具调用且停止原因为 `stop` 时改为 `toolUse`。
   */
  const finalizeResponse = (
    response: Extract<
      ResponseStreamEvent,
      { type: "response.completed" | "response.incomplete" }
    >["response"],
  ): void => {
    hasSeenTerminalResponseEvent = true;
    backfillReasoningSignatures(response.output ?? []);
    if (response?.id) {
      output.responseId = response.id;
    }
    if (response?.usage) {
      const inputDetails = response.usage.input_tokens_details as
        { cached_tokens?: number; cache_write_tokens?: number } | undefined;
      const cachedTokens = inputDetails?.cached_tokens || 0;
      const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
      output.usage = {
        // OpenAI 的 input_tokens 包含缓存读取和写入 token，两者都需扣除。
        input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
        output: response.usage.output_tokens || 0,
        cacheRead: cachedTokens,
        cacheWrite: cacheWriteTokens,
        reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
        totalTokens: response.usage.total_tokens || 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    }
    calculateCost(model, output.usage);
    applyServiceTierPricing(output.usage, response?.service_tier ?? options?.serviceTier, model);
    // 将状态映射为停止原因。未完成响应保留提供商具体原因，以区分输出上限截断与内容过滤。
    const status = response?.status;
    const incompleteDetails = response?.incomplete_details as
      { reason?: unknown } | null | undefined;
    const incompleteReason =
      typeof incompleteDetails?.reason === "string" ? incompleteDetails.reason : undefined;
    output.rawStopReason = incompleteReason ? `${status}.${incompleteReason}` : status;
    const mappedStop = mapStopReason(status, incompleteReason);
    output.stopReason = mappedStop.stopReason;
    if (mappedStop.errorMessage === undefined) {
      delete output.errorMessage;
    } else {
      output.errorMessage = mappedStop.errorMessage;
    }
    if (
      output.content.some(
        (b: TextContent | ThinkingContent | ToolCall): b is ToolCall => b.type === "toolCall",
      ) &&
      output.stopReason === "stop"
    ) {
      output.stopReason = "toolUse";
    }
  };

  for await (const event of openaiStream) {
    await (options?.onStreamEvent ?? options?.onProviderStreamEvent)?.(event, model);
    if (event.type === "response.created") {
      output.responseId = event.response.id;
    } else if (event.type === "response.output_item.added") {
      createSlot(event.output_index, event.item);
    } else if (
      event.type === "response.reasoning_summary_text.delta" ||
      event.type === "response.reasoning_text.delta"
    ) {
      const slot = getSlot(event.output_index, "thinking");
      if (!slot) {
        continue;
      }
      slot.block.thinking += event.delta;
      stream.push({
        type: "thinking_delta",
        contentIndex: slot.contentIndex,
        delta: event.delta,
        partial: output,
      });
    } else if (event.type === "response.reasoning_summary_part.done") {
      const slot = getSlot(event.output_index, "thinking");
      if (!slot) {
        continue;
      }
      slot.block.thinking += "\n\n";
      stream.push({
        type: "thinking_delta",
        contentIndex: slot.contentIndex,
        delta: "\n\n",
        partial: output,
      });
    } else if (
      event.type === "response.output_text.delta" ||
      event.type === "response.refusal.delta"
    ) {
      const slot = getSlot(event.output_index, "text");
      if (!slot) {
        continue;
      }
      slot.block.text += event.delta;
      stream.push({
        type: "text_delta",
        contentIndex: slot.contentIndex,
        delta: event.delta,
        partial: output,
      });
    } else if (event.type === "response.function_call_arguments.delta") {
      const slot = getSlot(event.output_index, "toolCall");
      if (!slot || slot.block.partialJson === undefined) {
        continue;
      }
      slot.block.partialJson += event.delta;
      slot.block.arguments = parseStreamingJson(slot.block.partialJson);
      pushToolCallDelta(slot, event.delta);
    } else if (event.type === "response.function_call_arguments.done") {
      const slot = getSlot(event.output_index, "toolCall");
      if (!slot || slot.block.partialJson === undefined) {
        continue;
      }
      const previousPartialJson = slot.block.partialJson;
      slot.block.partialJson = event.arguments;
      slot.block.arguments = parseStreamingJson(slot.block.partialJson);

      if (event.arguments.startsWith(previousPartialJson)) {
        const delta = event.arguments.slice(previousPartialJson.length);
        if (delta.length > 0) {
          pushToolCallDelta(slot, delta);
        }
      }
    } else if (event.type === "response.custom_tool_call_input.delta") {
      const slot = getSlot(event.output_index, "toolCall");
      if (!slot || !slot.block.customInput) {
        continue;
      }
      const nextInput = getCustomToolCallInput(slot.block) + event.delta;
      const inputDelta = appendCustomToolCallInput(slot.block, nextInput, false);
      pushToolCallDelta(slot, inputDelta);
    } else if (event.type === "response.custom_tool_call_input.done") {
      const slot = getSlot(event.output_index, "toolCall");
      if (!slot || !slot.block.customInput) {
        continue;
      }
      const doneDelta = appendCustomToolCallInput(slot.block, event.input, true);
      pushToolCallDelta(slot, doneDelta);
    } else if (event.type === "response.output_item.done") {
      const item = event.item;
      applyMessagePhaseStopReason(item);
      const slot = getOrCreateSlot(event.output_index, item);

      if (item.type === "reasoning" && slot?.type === "thinking") {
        const summaryText =
          item.summary?.map((s: ResponseReasoningItem.Summary): string => s.text).join("\n\n") ||
          "";
        const contentText =
          item.content?.map((c: ResponseReasoningItem.Content): string => c.text).join("\n\n") ||
          "";
        slot.block.thinking = summaryText || contentText || slot.block.thinking;
        slot.block.thinkingSignature = JSON.stringify(item);
        reasoningBlocksById.set(item.id, slot.block);
        stream.push({
          type: "thinking_end",
          contentIndex: slot.contentIndex,
          content: slot.block.thinking,
          partial: output,
        });
        outputSlots.delete(event.output_index);
      } else if (item.type === "message" && slot?.type === "text") {
        slot.block.text =
          item.content
            ?.map((c: ResponseOutputRefusal | ResponseOutputText): string =>
              c.type === "output_text" ? c.text : c.refusal,
            )
            .join("") || "";
        slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
        stream.push({
          type: "text_end",
          contentIndex: slot.contentIndex,
          content: slot.block.text,
          partial: output,
        });
        outputSlots.delete(event.output_index);
      } else if (
        item.type === "function_call" &&
        slot?.type === "toolCall" &&
        slot.block.partialJson !== undefined
      ) {
        slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");
        if (item.namespace !== undefined) {
          slot.block.namespace = item.namespace;
        }
        // 就地完成工具参数解析并删除临时缓冲区，回放仅保留已解析参数。
        delete slot.block.partialJson;
        stream.push({
          type: "toolcall_end",
          contentIndex: slot.contentIndex,
          toolCall: slot.block,
          partial: output,
        });
        outputSlots.delete(event.output_index);
      } else if (
        item.type === "custom_tool_call" &&
        slot?.type === "toolCall" &&
        slot.block.customInput
      ) {
        const finalInput = item.input ?? getCustomToolCallInput(slot.block);
        const finalDelta = appendCustomToolCallInput(slot.block, finalInput, true);
        pushToolCallDelta(slot, finalDelta);
        if (item.namespace !== undefined) {
          slot.block.namespace = item.namespace;
        }
        delete slot.block.customInput;
        stream.push({
          type: "toolcall_end",
          contentIndex: slot.contentIndex,
          toolCall: slot.block,
          partial: output,
        });
        outputSlots.delete(event.output_index);
      }
    } else if (event.type === "response.completed" || event.type === "response.incomplete") {
      finalizeResponse(event.response);
    } else if (event.type === "error") {
      throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
    } else if (event.type === "response.failed") {
      hasSeenTerminalResponseEvent = true;
      output.rawStopReason = event.response?.status;
      const error = event.response?.error;
      const details = event.response?.incomplete_details;
      const msg = error
        ? `${error.code || "unknown"}: ${error.message || "no message"}`
        : details?.reason
          ? `incomplete: ${details.reason}`
          : "Unknown error (no error details in response)";
      throw new Error(msg);
    }
  }
  if (!hasSeenTerminalResponseEvent) {
    throw new Error("OpenAI Responses stream ended before a terminal response event");
  }
  // 代理会执行最终消息中的全部工具调用，因此不能交付未收到 output_item.done 的调用。参数可能被截断或混淆，例如不符合协议的服务器省略 output_index。已完成调用的临时缓冲区已被移除。
  if (output.stopReason === "toolUse") {
    for (const block of output.content) {
      if (block.type !== "toolCall") {
        continue;
      }
      const toolCall = block as StreamingToolCall;
      if (toolCall.partialJson !== undefined || toolCall.customInput !== undefined) {
        throw new Error(
          `OpenAI Responses stream completed with an unfinished tool call: ${toolCall.name} (${toolCall.id})`,
        );
      }
    }
  }
}

/**
 * 将 Responses 响应状态映射为统一的停止原因，必要时附带错误信息。
 * @param status - 提供商返回的响应状态；缺失时视为正常结束。
 * @param incompleteReason - 状态为 `incomplete` 时提供商给出的具体原因。
 * @returns 停止原因及可选错误信息；`max_output_tokens` 截断映射为 `length`，其他未完成原因映射为 `error` 并附带说明。
 * @throws 遇到未覆盖的状态值时抛出错误。
 * @remarks `in_progress` 与 `queued` 状态按正常结束 `stop` 处理。
 */
function mapStopReason(
  status: OpenAI.Responses.ResponseStatus | undefined,
  incompleteReason?: string,
): { stopReason: StopReason; errorMessage?: string } {
  if (!status) {
    return { stopReason: "stop" };
  }
  switch (status) {
    case "completed":
      return { stopReason: "stop" };
    case "incomplete":
      if (incompleteReason === "max_output_tokens") {
        return { stopReason: "length" };
      }
      return {
        stopReason: "error",
        errorMessage: incompleteReason
          ? `Response incomplete: ${incompleteReason}`
          : "Response incomplete without a provider reason",
      };
    case "failed":
    case "cancelled":
      return { stopReason: "error" };
    // 非终止状态按正常停止处理，保持兼容端点的既有行为。
    case "in_progress":
    case "queued":
      return { stopReason: "stop" };
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled stop reason: ${_exhaustive}`);
    }
  }
}

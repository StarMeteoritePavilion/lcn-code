import type {
  BetaTool,
  BetaCacheControlEphemeral as CacheControlEphemeral,
  BetaContentBlockParam as ContentBlockParam,
  MessageCreateParamsStreaming,
  BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type {
  AnthropicAllowedFallbackModel,
  CacheRetention,
  ImageContent,
  Message,
  Model,
  StreamOptions,
  TextContent,
  Tool,
  ToolResultMessage,
} from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
  getCurrentTools,
  getInitialSystemMessage,
  type TranscriptContext,
} from "../utils/transcript.ts";
import { resolveStrictJsonSchema } from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";
import type {
  AnthropicEffort,
  AnthropicOptions,
  AnthropicThinkingDisplay,
} from "./anthropic-messages.ts";

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
export function getAnthropicCompat(model: Model<"anthropic-messages">): ResolvedAnthropicCompat {
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

/**
 * 获取请求使用的最大输出 token 数，优先使用请求选项。
 * @param model - 目标模型，选项未提供时使用其 maxTokens。
 * @param options - 可选的请求选项。
 * @returns 正整数形式的最大输出 token 数。
 * @throws 选项与模型都未提供 maxTokens，或取值不是正的安全整数时抛出错误。
 */
export function requireMaxTokens(
  model: Model<"anthropic-messages">,
  options?: StreamOptions,
): number {
  const maxTokens = options?.maxTokens ?? model.maxTokens;
  if (maxTokens === undefined || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(
      "Anthropic Messages requires a positive integer maxTokens in the model or request options",
    );
  }
  return maxTokens;
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
export function buildParams(
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

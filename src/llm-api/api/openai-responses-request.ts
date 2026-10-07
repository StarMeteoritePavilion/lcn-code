import type {
  ResponseCreateParamsStreaming,
  Tool as OpenAITool,
  ResponseInput,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputText,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import type {
  AssistantMessage,
  CacheRetention,
  ImageContent,
  Model,
  OpenAIResponsesCompat,
  SystemMessage,
  TextContent,
  TextSignatureV1,
  Tool,
  ToolCall,
  TranscriptContext,
} from "../types.ts";
import { shortHash } from "../utils/hash.ts";
import { resolveCacheRetention } from "../utils/cache-retention.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import { resolveTranscriptTools } from "../utils/transcript.ts";
import {
  getGrammarToolInput,
  makeStrictJsonSchema,
  resolveGrammarConstrainedSampling,
  resolveStrictJsonSchema,
} from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import type { OpenAIResponsesOptions } from "./openai-responses.ts";
import { resolveSamplingParams } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

// OpenAI Responses 拒绝小于 16 的 max_output_tokens，见 https://github.com/earendil-works/pi/issues/6265 。
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

type PromptCacheOptions = { mode: "explicit" } | { ttl: "30m" };

/**
 * 计算请求的 prompt_cache_retention 字段。
 * @param compat - 已解析的端点兼容能力。
 * @param cacheRetention - 已解析的缓存保留策略。
 * @returns 策略为 `long`、端点支持长缓存且不使用显式缓存模式时返回 `24h`，否则返回 undefined。
 */
function getPromptCacheRetention(
  compat: Required<OpenAIResponsesCompat>,
  cacheRetention: CacheRetention,
): "24h" | undefined {
  return cacheRetention === "long" &&
    compat.supportsLongCacheRetention &&
    !compat.supportsExplicitPromptCacheMode
    ? "24h"
    : undefined;
}

/**
 * 为支持显式提示缓存模式的端点生成 prompt_cache_options。
 * @param compat - 已解析的端点兼容能力。
 * @param cacheRetention - 已解析的缓存保留策略。
 * @returns 策略为 `none` 时返回显式模式，`long` 且支持长缓存时返回 30 分钟 TTL；端点不支持显式模式或其他情况返回 undefined。
 */
function getPromptCacheOptions(
  compat: Required<OpenAIResponsesCompat>,
  cacheRetention: CacheRetention,
): PromptCacheOptions | undefined {
  if (!compat.supportsExplicitPromptCacheMode) {
    return undefined;
  }
  if (cacheRetention === "none") {
    return { mode: "explicit" };
  }
  if (cacheRetention === "long" && compat.supportsLongCacheRetention) {
    return { ttl: "30m" };
  }
  return undefined;
}

/**
 * 将消息标识和阶段编码为 V1 文本签名 JSON 字符串。
 * @param id - Responses 输出消息标识。
 * @param phase - 消息阶段；为空时不写入。
 * @returns 序列化后的签名字符串。
 */
export function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
  const payload: TextSignatureV1 = { v: 1, id };
  if (phase) {
    payload.phase = phase;
  }
  return JSON.stringify(payload);
}

/**
 * 解析文本块签名，兼容 V1 JSON 格式与旧版纯字符串格式。
 * @param signature - 文本块保存的签名。
 * @returns 消息标识及可选阶段；签名为空时返回 undefined，非 V1 JSON 时整串作为标识。
 */
function parseTextSignature(
  signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
      if (parsed.v === 1 && typeof parsed.id === "string") {
        if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
          return { id: parsed.id, phase: parsed.phase };
        }
        return { id: parsed.id };
      }
    } catch {
      // 继续使用旧格式的普通字符串处理。
    }
  }
  return { id: signature };
}
/**
 * 根据会话、工具和端点能力构建 Responses 流式请求参数。
 * @param model - 目标模型及其采样和推理配置。
 * @param context - 已按端点能力整理的会话。
 * @param options - 请求的生成、缓存和工具选择配置。
 * @param compat - 已解析的端点兼容能力。
 * @param grammarToolInputProperties - 文法工具名称对应的输入属性名。
 * @returns 使用 SDK 流式请求类型的参数对象。
 * @throws 消息、工具或采样配置转换中的错误会向调用方传播。
 * @remarks 最后合并采样参数，因此同名请求字段会被覆盖。
 */
export function buildParams(
  model: Model<"openai-responses">,
  context: TranscriptContext,
  options: OpenAIResponsesOptions,
  compat: Required<OpenAIResponsesCompat>,
  grammarToolInputProperties: ReadonlyMap<string, string>,
): ResponseCreateParamsStreaming {
  const transcriptTools = resolveTranscriptTools(
    context.messages,
    compat.supportsAdditionalTools || compat.supportsToolSearch,
  );
  const messages = convertResponsesMessages(
    model,
    context,
    {
      grammarToolInputProperties,
      supportsAdditionalTools: compat.supportsAdditionalTools,
      supportsToolSearch: compat.supportsToolSearch,
      toolOptions: {
        supportsStrictMode: compat.supportsStrictMode,
        supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
      },
    },
    transcriptTools,
  );

  const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
  const params: ResponseCreateParamsStreaming = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key:
      cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
    prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
    prompt_cache_options: getPromptCacheOptions(compat, cacheRetention),
    store: false,
  };

  if (options?.maxTokens && compat.supportsMaxOutputTokens) {
    params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
  }

  if (options?.temperature !== undefined) {
    params.temperature = options?.temperature;
  }

  if (options?.serviceTier !== undefined) {
    params.service_tier = options.serviceTier;
  }

  if (transcriptTools.requestTools.length > 0) {
    params.tools = convertResponsesTools(transcriptTools.requestTools, {
      supportsStrictMode: compat.supportsStrictMode,
      supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
    });
  }

  if (options?.toolChoice !== undefined) {
    params.tool_choice = options.toolChoice;
  }

  const reasoningEffort =
    options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
  if (model.reasoning !== false) {
    if (reasoningEffort) {
      const effort = options?.reasoningEffort
        ? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
        : reasoningEffort;
      params.reasoning = {
        effort: effort as NonNullable<typeof params.reasoning>["effort"],
        summary: options?.reasoningSummary || "auto",
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (model.reasoning && model.thinkingLevelMap?.off !== null) {
      params.reasoning = {
        effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<
          typeof params.reasoning
        >["effort"],
      };
    }
  }

  // 最后合并模型及请求采样参数，使其覆盖具名请求字段。
  const samplingParams = resolveSamplingParams(
    model,
    reasoningEffort ?? "off",
    options?.samplingParams,
  );
  if (samplingParams) {
    Object.assign(params, samplingParams);
  }

  return params;
}

// =============================================================================
// 通用辅助方法。

type ToolResultOutputContent = Array<ResponseInputText | ResponseInputImage>;

/**
 * 将工具结果内容转换为 Responses 工具输出格式。
 * @param model - 用于判断是否支持图片输入的目标模型。
 * @param content - 工具结果中的文本与图片内容。
 * @returns 无图片或模型不支持图片时返回纯文本（无文本时使用占位说明）；否则返回文本与图片输入数组。
 */
function convertToolResultOutput(
  model: Model<"openai-responses">,
  content: readonly (TextContent | ImageContent)[],
): string | ToolResultOutputContent {
  const textBlocks = content.filter(
    (c: ImageContent | TextContent): c is TextContent => c.type === "text",
  );
  const textResult = textBlocks.map((c: TextContent): string => c.text).join("\n");
  const images = content.filter(
    (c: ImageContent | TextContent): c is ImageContent => c.type === "image",
  );
  const hasText = textResult.length > 0;

  if (images.length === 0 || (model.input !== undefined && !model.input.includes("image"))) {
    return sanitizeSurrogates(
      hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)",
    );
  }

  const output: ToolResultOutputContent = [];
  if (hasText) {
    output.push({ type: "input_text", text: sanitizeSurrogates(textResult) });
  }
  for (const image of images) {
    output.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  return output;
}

interface ConvertResponsesMessagesOptions {
  grammarToolInputProperties?: ReadonlyMap<string, string>;
  supportsAdditionalTools?: boolean;
  supportsToolSearch?: boolean;
  toolOptions?: ConvertResponsesToolsOptions;
}

interface ConvertResponsesToolsOptions {
  strict?: boolean | null;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  toolSearchResult?: boolean;
}

// =============================================================================
// 消息转换。

/**
 * 将已按端点能力整理的会话转换为 Responses 请求输入。
 * @param model - 用于确定历史消息和工具标识符兼容规则的目标模型。
 * @param context - 已按端点系统消息能力整理的会话。
 * @param options - 系统消息、工具和工具调用格式转换选项。
 * @param transcriptTools - 会话工具状态，默认根据端点能力从会话解析。
 * @returns 转换后的请求输入；空会话返回空数组。
 * @throws 工具调用标识符缺少片段时抛出错误；思考签名解析和工具转换错误会向调用方传播。
 * @remarks 历史工具调用的条目标识符会按端点、模型和工具类型决定是否保留。
 */
function convertResponsesMessages(
  model: Model<"openai-responses">,
  context: TranscriptContext,
  options?: ConvertResponsesMessagesOptions,
  transcriptTools: ReturnType<typeof resolveTranscriptTools> = resolveTranscriptTools(
    context.messages,
    (options?.supportsAdditionalTools ?? false) || (options?.supportsToolSearch ?? false),
  ),
): ResponseInput {
  const messages: ResponseInput = [];

  /**
   * 将标识符片段规范为 OpenAI 允许的字符集与长度。
   * @param part - 原始标识符片段。
   * @returns 非法字符替换为下划线、截断至 64 字符并去除末尾下划线后的片段。
   */
  const normalizeIdPart = (part: string): string => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };

  /**
   * 规范历史工具调用标识，使 `callId|itemId` 形式符合目标端点要求。
   * @param id - 原始工具调用标识，可能为 `callId|itemId` 组合形式。
   * @param _targetModel - 目标模型（未使用，保留以匹配回调签名）。
   * @param source - 产生该工具调用的助手消息。
   * @returns 规范后的标识；来自其他端点或协议时 itemId 替换为 `fc_` 加哈希，itemId 不以 `fc_`/`ctc_` 开头时同样替换。
   * @throws 组合标识缺少片段时抛出错误。
   */
  const normalizeToolCallId = (
    id: string,
    _targetModel: Model<"openai-responses">,
    source: AssistantMessage,
  ): string => {
    if (!id.includes("|")) {
      return normalizeIdPart(id);
    }
    const [callId, itemId] = id.split("|");
    if (callId === undefined || itemId === undefined) {
      throw new Error("Missing tool call ID segment");
    }
    if (source.baseUrl !== model.baseUrl || source.api !== model.api) {
      return `${normalizeIdPart(callId)}|fc_${shortHash(itemId)}`;
    }
    let normalizedItemId = normalizeIdPart(itemId);
    if (!normalizedItemId.startsWith("fc_") && !normalizedItemId.startsWith("ctc_")) {
      normalizedItemId = `fc_${shortHash(itemId)}`;
    }
    return `${normalizeIdPart(callId)}|${normalizedItemId}`;
  };

  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
  /**
   * 将系统消息新增的工具以 additional_tools 或客户端工具搜索调用的形式追加到请求输入。
   * @param message - 携带 toolsAdded 的系统消息。
   * @param seed - 用于生成稳定工具搜索调用标识的种子。
   * @remarks 会向外层 `messages` 追加条目；会话不锚定新增工具、无新增工具或端点两种能力均不支持时不追加。
   */
  const appendSystemToolAdditions = (message: SystemMessage, seed: string): void => {
    const tools = transcriptTools.anchorsAdditions ? (message.toolsAdded ?? []) : [];
    if (tools.length === 0) {
      return;
    }
    if (options?.supportsAdditionalTools) {
      messages.push({
        type: "additional_tools",
        role: "developer",
        tools: convertResponsesTools(tools, options.toolOptions),
      } satisfies ResponseInputItem);
      return;
    }
    if (!options?.supportsToolSearch) {
      return;
    }
    const names = tools.map((tool: Tool): string => tool.name);
    const callId = `pi_tool_load_${shortHash(`${seed}:${names.join(",")}`)}`;
    messages.push({
      type: "tool_search_call",
      call_id: callId,
      execution: "client",
      status: "completed",
      arguments: { query: names.join(" "), limit: names.length },
    } satisfies ResponseInputItem);
    messages.push({
      type: "tool_search_output",
      call_id: callId,
      execution: "client",
      status: "completed",
      tools: convertResponsesTools(tools, { ...options.toolOptions, toolSearchResult: true }),
    } satisfies ResponseToolSearchOutputItemParam);
  };
  const instructionRole =
    model.reasoning && model.compat?.supportsDeveloperRole !== false ? "developer" : "system";

  let msgIndex = 0;
  let sourceIndex = 0;
  for (const msg of transformedMessages) {
    const isLeadingSystemMessage = sourceIndex++ === 0 && msg.role === "system";
    if (msg.role === "system") {
      if (!isLeadingSystemMessage) {
        appendSystemToolAdditions(msg, `system:${msgIndex}`);
      }
      const text = isLeadingSystemMessage
        ? getSystemMessageText(msg)
        : renderSystemMessageUpdate(msg);
      if (text.length > 0) {
        messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });
      }
    } else if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
        });
      } else {
        const content: ResponseInputContent[] = msg.content.map(
          (item: ImageContent | TextContent): ResponseInputContent => {
            if (item.type === "text") {
              return {
                type: "input_text",
                text: sanitizeSurrogates(item.text),
              } satisfies ResponseInputText;
            }
            return {
              type: "input_image",
              detail: "auto",
              image_url: `data:${item.mimeType};base64,${item.data}`,
            } satisfies ResponseInputImage;
          },
        );
        if (content.length === 0) {
          continue;
        }
        messages.push({
          role: "user",
          content,
        });
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      const assistantMsg = msg as AssistantMessage;
      const isSameEndpoint =
        assistantMsg.baseUrl === model.baseUrl && assistantMsg.api === model.api;
      const isSameModel = isSameEndpoint && assistantMsg.model === model.id;
      const isDifferentModel = isSameEndpoint && assistantMsg.model !== model.id;
      let textBlockIndex = 0;

      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
            output.push(reasoningItem);
          }
        } else if (block.type === "text") {
          const textBlock = block as TextContent;
          const parsedSignature = parseTextSignature(textBlock.textSignature);
          const fallbackMessageId =
            textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
          textBlockIndex++;
          // OpenAI 要求 id 最多为 64 个字符。
          let msgId = parsedSignature?.id;
          if (!msgId) {
            msgId = fallbackMessageId;
          } else if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          output.push({
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] },
            ],
            status: "completed",
            id: msgId,
            phase: parsedSignature?.phase,
          } satisfies ResponseOutputMessage);
        } else if (block.type === "toolCall") {
          const toolCall = block as ToolCall;
          const [callId, itemIdRaw] = toolCall.id.split("|");
          if (callId === undefined) {
            throw new Error("Missing tool call ID segment");
          }
          const customInputProperty = options?.grammarToolInputProperties?.get(toolCall.name);
          let itemId: string | undefined = itemIdRaw;

          // 端点、协议或模型变化时省略 id，避免触发配对校验；OpenAI 会记录条目 id 与 rs_xxx 推理条目的配对。类型不匹配的 id 也须移除：function_call 使用 fc_*，custom_tool_call 使用 ctc_*；grammar 工具支持情况改变时，调用可能在两种类型之间切换。
          const isForeignEndpoint =
            assistantMsg.baseUrl !== model.baseUrl || assistantMsg.api !== model.api;
          const itemIdPrefix = customInputProperty === undefined ? "fc_" : "ctc_";
          if (customInputProperty !== undefined && isForeignEndpoint) {
            itemId = undefined;
          }
          if (isDifferentModel || !itemId?.startsWith(itemIdPrefix)) {
            itemId = undefined;
          }

          if (customInputProperty !== undefined) {
            const grammarInput = getGrammarToolInput(
              toolCall.name,
              toolCall.arguments,
              customInputProperty,
            );
            output.push({
              type: "custom_tool_call",
              id: itemId,
              call_id: callId,
              name: toolCall.name,
              input: sanitizeSurrogates(grammarInput),
              ...(isSameModel && toolCall.namespace !== undefined
                ? { namespace: toolCall.namespace }
                : {}),
            } satisfies ResponseOutputItem);
          } else {
            output.push({
              type: "function_call",
              id: itemId,
              call_id: callId,
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments),
              ...(isSameModel && toolCall.namespace !== undefined
                ? { namespace: toolCall.namespace }
                : {}),
            });
          }
        }
      }
      if (output.length === 0) {
        continue;
      }
      messages.push(...output);
    } else if (msg.role === "toolResult") {
      const [callId] = msg.toolCallId.split("|");
      if (callId === undefined) {
        throw new Error("Missing tool call ID segment");
      }
      const output = convertToolResultOutput(model, msg.content);

      if (options?.grammarToolInputProperties?.has(msg.toolName)) {
        messages.push({
          type: "custom_tool_call_output",
          call_id: callId,
          output,
        });
      } else {
        messages.push({
          type: "function_call_output",
          call_id: callId,
          output,
        });
      }
    }
    if (!isLeadingSystemMessage) {
      msgIndex++;
    }
  }

  return messages;
}

// =============================================================================
// 工具转换。

/**
 * 将工具定义转换为 Responses 的函数工具或文法工具格式。
 * @param tools - 待转换的工具定义。
 * @param options - 严格模式、文法工具和工具搜索结果配置。
 * @returns 转换后的工具数组；没有工具时返回空数组。
 * @throws 工具约束或严格 JSON Schema 转换错误会向调用方传播。
 */
function convertResponsesTools(
  tools: readonly Tool[],
  options?: ConvertResponsesToolsOptions,
): OpenAITool[] {
  const defaultStrict = options?.strict === undefined ? false : options.strict;
  const canUseStrictMode = options?.supportsStrictMode ?? true;
  const canUseOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;

  return tools.map((tool: Tool): OpenAITool => {
    const grammar = resolveGrammarConstrainedSampling(tool, canUseOpenAIGrammarTools);
    if (grammar) {
      return {
        type: "custom",
        name: tool.name,
        description: tool.description,
        format: {
          type: "grammar",
          syntax: grammar.format,
          definition: grammar.definition,
        },
        ...(options?.toolSearchResult ? { defer_loading: true } : {}),
      } satisfies OpenAITool;
    }

    const strictParameters = resolveStrictJsonSchema(tool, canUseStrictMode);
    const strict = strictParameters === undefined ? defaultStrict : true;
    const functionTool: Omit<Extract<OpenAITool, { type: "function" }>, "strict"> & {
      strict?: Extract<OpenAITool, { type: "function" }>["strict"];
    } = {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters:
        strictParameters ??
        (strict === true
          ? makeStrictJsonSchema(tool.parameters)
          : (tool.parameters as Record<string, unknown>)),
      ...(options?.toolSearchResult ? { defer_loading: true } : {}),
    };
    if (canUseStrictMode) {
      functionTool.strict = strict;
    }
    return functionTool as OpenAITool;
  });
}

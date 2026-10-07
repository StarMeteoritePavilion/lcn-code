import type OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionDeveloperMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionSystemMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import type {
  CacheRetention,
  ChatTemplateKwargValue,
  JsonValue,
  ImageContent,
  Message,
  Model,
  OpenAICompletionsCompat,
  TextContent,
  ThinkingContent,
  ThinkingTokenBudgetField,
  Tool,
  ToolCall,
} from "../types.ts";
import { shortHash } from "../utils/hash.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
  resolveTranscriptTools,
  type TranscriptContext,
  type TranscriptTools,
} from "../utils/transcript.ts";
import {
  getGrammarToolInput,
  resolveGrammarConstrainedSampling,
  resolveStrictJsonSchema,
} from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
  clampThinkingBudgetToAnswerRoom,
  resolveSamplingParams,
  thinkingBudgetForLevel,
} from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";
import type { OpenAICompletionsOptions } from "./openai-completions.ts";

/**
 * 判断会话中是否已经出现过工具调用或工具结果。
 * @param messages - 待检查的会话消息。
 * @returns 存在工具结果消息或包含工具调用块的助手消息时返回 true，否则返回 false。
 */
function hasToolHistory(messages: Message[]): boolean {
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      return true;
    }
    if (msg.role === "assistant") {
      if (
        msg.content.some(
          (block: TextContent | ThinkingContent | ToolCall): block is ToolCall =>
            block.type === "toolCall",
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function isReasoningDetailObject(detail: unknown): detail is Record<string, unknown> {
  return typeof detail === "object" && detail !== null && !Array.isArray(detail);
}

/**
 * 校验 reasoning detail 的公共可选字段类型是否合法。
 * @param detail - 待校验的 reasoning detail 对象。
 * @returns `id` 为空或字符串、`format` 缺省或为字符串、`index` 缺省或为数字时返回 true，否则返回 false。
 */
function hasValidCommonReasoningDetailFields(detail: Record<string, unknown>): boolean {
  return (
    (detail.id === undefined || detail.id === null || typeof detail.id === "string") &&
    (detail.format === undefined || typeof detail.format === "string") &&
    (detail.index === undefined || typeof detail.index === "number")
  );
}

/**
 * 判断任意值是否为受支持的 OpenAI 兼容 reasoning detail。
 * @param detail - 待判断的值。
 * @returns 公共字段合法，且类型为 `reasoning.summary`、`reasoning.encrypted` 或 `reasoning.text` 并带有对应字符串字段时返回 true；其他类型返回 false。
 */
export function isOpenAIReasoningDetail(detail: unknown): detail is OpenAIReasoningDetail {
  if (!isReasoningDetailObject(detail) || !hasValidCommonReasoningDetailFields(detail)) {
    return false;
  }
  switch (detail.type) {
    case "reasoning.summary":
      return typeof detail.summary === "string";
    case "reasoning.encrypted":
      return typeof detail.data === "string";
    case "reasoning.text":
      return (
        typeof detail.text === "string" &&
        (detail.signature === undefined ||
          detail.signature === null ||
          typeof detail.signature === "string")
      );
    default:
      return false;
  }
}

interface ConvertCompletionsMessagesOptions {
  grammarToolInputProperties?: ReadonlyMap<string, string>;
}

interface OpenAICompatCacheControl {
  type: "ephemeral";
  ttl?: string;
}

export type ResolvedOpenAICompletionsCompat = Omit<
  Required<OpenAICompletionsCompat>,
  | "cacheControlFormat"
  | "supportsThinkingTokenBudget"
  | "thinkingTokenBudgetField"
  | "supportsMidConvoSystemMessages"
  | "supportsMidConvoToolAdditions"
  | "openRouterRouting"
  | "vercelGatewayRouting"
  | "vllmPriority"
> & {
  cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
  supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
  thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
  supportsMidConvoSystemMessages?: OpenAICompletionsCompat["supportsMidConvoSystemMessages"];
  supportsMidConvoToolAdditions?: OpenAICompletionsCompat["supportsMidConvoToolAdditions"];
  vllmPriority?: OpenAICompletionsCompat["vllmPriority"];
  openRouterRouting?: OpenAICompletionsCompat["openRouterRouting"];
  vercelGatewayRouting?: OpenAICompletionsCompat["vercelGatewayRouting"];
};

type ResolvedChatTemplateKwargValue = string | number | boolean | null;

type ChatCompletionInstructionMessageParam =
  ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam;

type ToolSystemMessageParam = {
  role: "system";
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
};

type OpenAIReasoningDetailBase = Record<string, JsonValue> & {
  id?: string | null;
  format?: string;
  index?: number;
};

type OpenAIReasoningSummaryDetail = OpenAIReasoningDetailBase & {
  type: "reasoning.summary";
  summary: string;
};

type OpenAIEncryptedReasoningDetail = OpenAIReasoningDetailBase & {
  type: "reasoning.encrypted";
  data: string;
};

type OpenAIReasoningTextDetail = OpenAIReasoningDetailBase & {
  type: "reasoning.text";
  text: string;
  signature?: string | null;
};

type OpenAIReasoningDetail =
  OpenAIReasoningSummaryDetail | OpenAIEncryptedReasoningDetail | OpenAIReasoningTextDetail;

/**
 * 从思考块签名中解析保存的 reasoning detail 列表。
 * @param signature - 思考块签名，可能是 JSON 序列化的 reasoning detail 数组。
 * @returns 解析结果为非空且每项均合法的数组时返回该数组；签名为空、JSON 无效或内容不合法时返回 undefined。
 */
function parseOpenAIReasoningDetails(
  signature: string | undefined,
): OpenAIReasoningDetail[] | undefined {
  if (!signature) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(signature) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isOpenAIReasoningDetail)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 用来源 detail 补齐目标 detail 中缺失的公共字段。
 * @param target - 被原地补齐的目标 detail。
 * @param source - 提供补齐值的来源 detail。
 * @remarks `id`、`index` 仅在目标为 null/undefined 时补齐；`format` 在目标为假值时补齐。
 */
function fillMissingCommonReasoningDetailFields(
  target: OpenAIReasoningDetailBase,
  source: OpenAIReasoningDetail,
): void {
  target.id ??= source.id;
  target.format ||= source.format;
  target.index ??= source.index;
}

/**
 * 将流式 reasoning detail 增量追加到已收集列表中。
 * @param details - 已收集的 detail 列表，会被原地修改。
 * @param detail - 新收到的 detail 增量。
 * @remarks 与末尾条目同为 `reasoning.text` 或 `reasoning.summary` 时合并文本并补齐公共字段；其余情况追加浅拷贝，加密条目始终独立保存。
 */
export function appendOpenAIReasoningDetail(
  details: OpenAIReasoningDetail[],
  detail: OpenAIReasoningDetail,
): void {
  const lastDetail = details[details.length - 1];
  if (detail.type === "reasoning.text" && lastDetail?.type === "reasoning.text") {
    lastDetail.text += detail.text;
    lastDetail.signature ||= detail.signature;
    fillMissingCommonReasoningDetailFields(lastDetail, detail);
    return;
  }
  if (detail.type === "reasoning.summary" && lastDetail?.type === "reasoning.summary") {
    lastDetail.summary += detail.summary;
    fillMissingCommonReasoningDetailFields(lastDetail, detail);
    return;
  }
  details.push({ ...detail });
}

const OPENAI_COMPLETIONS_REASONING_FIELDS = [
  "reasoning",
  "reasoning_content",
  "reasoning_text",
] as const;

type OpenAICompletionsReasoningField = (typeof OPENAI_COMPLETIONS_REASONING_FIELDS)[number];

function isOpenAICompletionsReasoningField(
  field: string,
): field is OpenAICompletionsReasoningField {
  return OPENAI_COMPLETIONS_REASONING_FIELDS.includes(field as OpenAICompletionsReasoningField);
}

type ChatCompletionAssistantMessageParamWithReasoning = ChatCompletionAssistantMessageParam &
  Partial<Record<OpenAICompletionsReasoningField, string>> & {
    reasoning_details?: JsonValue[];
  };

type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
  cache_control?: OpenAICompatCacheControl;
};

type ChatCompletionToolWithCacheControl = OpenAI.Chat.Completions.ChatCompletionTool & {
  cache_control?: OpenAICompatCacheControl;
};

/**
 * 构建 Chat Completions 流式请求参数。
 * @param model - 请求模型，决定推理能力、推理等级映射与路由配置。
 * @param context - 已按端点能力整理的会话上下文。
 * @param options - 请求选项，包括最大 token、温度、工具选择与推理强度等。
 * @param compat - 端点兼容配置，决定字段名称与推理参数格式。
 * @param cacheRetention - 已解析的缓存保留策略。
 * @param grammarToolInputProperties - grammar 工具名到输入属性名的映射。
 * @returns 可直接发送的流式请求参数。
 * @remarks 按 `compat.thinkingFormat` 写入不同格式的推理参数；配置了思考预算字段时写入收敛后的预算；采样参数最后合并，可覆盖前面的同名字段。
 */
export function buildParams(
  model: Model<"openai-completions">,
  context: TranscriptContext,
  options: OpenAICompletionsOptions,
  compat: ResolvedOpenAICompletionsCompat,
  cacheRetention: CacheRetention,
  grammarToolInputProperties: ReadonlyMap<string, string>,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  const transcriptTools: TranscriptTools = resolveTranscriptTools(
    context.messages,
    compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true,
  );
  const messages = convertMessages(
    model,
    context,
    compat,
    { grammarToolInputProperties },
    transcriptTools,
  );
  const cacheControl = getCompatCacheControl(compat, cacheRetention);

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model: model.id,
    messages,
    stream: true,
    prompt_cache_key:
      (model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
      (cacheRetention === "long" && compat.supportsLongCacheRetention)
        ? clampOpenAIPromptCacheKey(options?.sessionId)
        : undefined,
    prompt_cache_retention:
      cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
  };

  if (compat.supportsUsageInStreaming !== false) {
    params.stream_options = { include_usage: true };
  }

  if (compat.supportsStore) {
    params.store = false;
  }

  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      // OpenAI 已弃用该字段，但部分兼容提供商仅接受 max_tokens。
      (params as { max_tokens?: number }).max_tokens = options.maxTokens;
    } else {
      params.max_completion_tokens = options.maxTokens;
    }
  }

  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  if (transcriptTools.requestTools.length > 0) {
    params.tools = convertTools(transcriptTools.requestTools, compat);
    if (compat.zaiToolStream) {
      (params as unknown as Record<string, unknown>).tool_stream = true;
    }
  } else if (hasToolHistory(context.messages)) {
    // 通过 LiteLLM 或代理调用 Anthropic 时，会话包含 tool_calls 或工具结果就必须提供 tools 参数。
    params.tools = [];
  }

  if (cacheControl) {
    applyAnthropicCacheControl(messages, params.tools, cacheControl);
  }

  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }

  if (compat.vllmPriority !== undefined) {
    (params as unknown as Record<string, unknown>).priority = compat.vllmPriority;
  }

  const thinkingTokenBudgetField = resolveThinkingTokenBudgetField(compat);
  const thinkingBudget = resolveClampedThinkingBudget(model, options, params);

  if (compat.thinkingFormat === "zai" && model.reasoning !== false) {
    const zaiParams = params as Omit<typeof params, "reasoning_effort"> & {
      thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean };
      reasoning_effort?: string;
    };
    // 只有显式声明推理能力的模型才发送关闭参数；未声明的模型仅在启用时发送参数。
    if (options?.reasoningEffort || model.reasoning === true) {
      zaiParams.thinking = options?.reasoningEffort
        ? { type: "enabled", clear_thinking: false }
        : { type: "disabled" };
    }
    if (options?.reasoningEffort && compat.supportsReasoningEffort) {
      const mappedEffort = model.thinkingLevelMap?.[options.reasoningEffort];
      const effort = mappedEffort === undefined ? options.reasoningEffort : mappedEffort;
      if (typeof effort === "string") {
        zaiParams.reasoning_effort = effort;
      }
    }
  } else if (compat.thinkingFormat === "qwen" && model.reasoning !== false) {
    if (options?.reasoningEffort || model.reasoning === true) {
      (params as unknown as Record<string, unknown>).enable_thinking = !!options?.reasoningEffort;
    }
    if (options?.reasoningEffort && compat.supportsReasoningEffort) {
      const effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
      if (typeof effort === "string") {
        (params as unknown as Record<string, unknown>).reasoning_effort = effort;
      }
    }
  } else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning !== false) {
    if (options?.reasoningEffort || model.reasoning === true) {
      (params as unknown as Record<string, unknown>).chat_template_kwargs = {
        enable_thinking: !!options?.reasoningEffort,
        preserve_thinking: true,
      };
    }
  } else if (compat.thinkingFormat === "chat-template" && model.reasoning !== false) {
    const chatTemplateKwargs = buildChatTemplateValues(
      model,
      options,
      compat.chatTemplateKwargs,
      thinkingBudget,
    );
    if (chatTemplateKwargs) {
      (params as unknown as Record<string, unknown>).chat_template_kwargs = chatTemplateKwargs;
    }
  } else if (compat.thinkingFormat === "baseten" && model.reasoning !== false) {
    const basetenParams = params as Omit<typeof params, "reasoning_effort"> & {
      chat_template_args?: Record<string, ResolvedChatTemplateKwargValue>;
      reasoning_effort?: string;
    };
    const chatTemplateArgs = buildChatTemplateValues(
      model,
      options,
      compat.chatTemplateArgs,
      thinkingBudget,
    );
    if (chatTemplateArgs) {
      basetenParams.chat_template_args = chatTemplateArgs;
    }
    if (compat.supportsReasoningEffort && (options?.reasoningEffort || model.reasoning === true)) {
      const requestedEffort = options?.reasoningEffort;
      const mappedEffort = requestedEffort
        ? model.thinkingLevelMap?.[requestedEffort]
        : model.thinkingLevelMap?.off;
      const effort = mappedEffort === undefined ? requestedEffort : mappedEffort;
      if (typeof effort === "string") {
        basetenParams.reasoning_effort = effort;
      }
    }
  } else if (compat.thinkingFormat === "deepseek" && model.reasoning !== false) {
    if (options?.reasoningEffort) {
      (params as unknown as Record<string, unknown>).thinking = { type: "enabled" };
    } else if (model.reasoning === true && model.thinkingLevelMap?.off !== null) {
      (params as unknown as Record<string, unknown>).thinking = { type: "disabled" };
    }
    if (options?.reasoningEffort && compat.supportsReasoningEffort) {
      (params as unknown as Record<string, unknown>).reasoning_effort =
        model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
    }
  } else if (compat.thinkingFormat === "openrouter" && model.reasoning !== false) {
    // OpenRouter 通过嵌套 reasoning 对象统一各提供商的推理选项。
    const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
    if (options?.reasoningEffort) {
      openRouterParams.reasoning = {
        effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
      };
    } else if (model.reasoning === true && model.thinkingLevelMap?.off !== null) {
      openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
    }
  } else if (
    compat.thinkingFormat === "ant-ling" &&
    model.reasoning !== false &&
    options?.reasoningEffort
  ) {
    const effort = model.thinkingLevelMap?.[options.reasoningEffort];
    if (typeof effort === "string") {
      (params as typeof params & { reasoning?: { effort: string } }).reasoning = { effort };
    }
  } else if (compat.thinkingFormat === "together" && model.reasoning !== false) {
    const togetherParams = params as Omit<typeof params, "reasoning_effort"> & {
      reasoning?: { enabled: boolean };
      reasoning_effort?: string;
    };
    if (options?.reasoningEffort || model.reasoning === true) {
      togetherParams.reasoning = { enabled: !!options?.reasoningEffort };
    }
    if (options?.reasoningEffort && compat.supportsReasoningEffort) {
      togetherParams.reasoning_effort =
        model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
    }
  } else if (compat.thinkingFormat === "string-thinking" && model.reasoning !== false) {
    const stringThinkingParams = params as typeof params & { thinking?: string };
    if (options?.reasoningEffort) {
      stringThinkingParams.thinking =
        model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
    } else if (model.reasoning === true && model.thinkingLevelMap?.off !== null) {
      stringThinkingParams.thinking = model.thinkingLevelMap?.off ?? "none";
    }
  } else if (
    options?.reasoningEffort &&
    model.reasoning !== false &&
    compat.supportsReasoningEffort
  ) {
    // 使用 OpenAI 格式的 reasoning_effort。
    (params as unknown as Record<string, unknown>).reasoning_effort =
      model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
  } else if (
    !options?.reasoningEffort &&
    model.reasoning === true &&
    compat.supportsReasoningEffort
  ) {
    const offValue = model.thinkingLevelMap?.off;
    if (typeof offValue === "string") {
      (params as unknown as Record<string, unknown>).reasoning_effort = offValue;
    }
  }

  // 通过顶层预算字段限制推理 token 数，与 thinkingFormat 独立；同一服务器可提供 zai、qwen 或 chat-template 模型。推理与回答共享 max_tokens，不限制推理预算可能耗尽整个响应，导致没有回答或工具调用。
  if (thinkingTokenBudgetField && thinkingBudget !== undefined) {
    Object.assign(params, { [thinkingTokenBudgetField]: thinkingBudget });
  }

  if (model.compat?.openRouterRouting) {
    (params as unknown as Record<string, unknown>).provider = model.compat.openRouterRouting;
  }

  if (model.compat?.vercelGatewayRouting) {
    const routing = model.compat.vercelGatewayRouting;
    if (routing.only || routing.order) {
      (params as unknown as Record<string, unknown>).providerOptions = {
        gateway: routing,
      };
    }
  }

  // 最后合并模型及请求采样参数，使其覆盖具名请求字段。
  const samplingParams = resolveSamplingParams(
    model,
    options?.reasoningEffort ?? "off",
    options?.samplingParams,
  );
  if (samplingParams) {
    Object.assign(params, samplingParams);
  }

  return params;
}

/**
 * 确定写入思考预算时使用的顶层请求字段名。
 * @param compat - 包含思考预算字段配置的兼容设置。
 * @returns 显式配置的字段名；仅声明支持思考预算时返回 `thinking_token_budget`；均未配置时返回 undefined。
 */
function resolveThinkingTokenBudgetField(
  compat: Pick<OpenAICompletionsCompat, "thinkingTokenBudgetField" | "supportsThinkingTokenBudget">,
): ThinkingTokenBudgetField | undefined {
  if (compat.thinkingTokenBudgetField) {
    return compat.thinkingTokenBudgetField;
  }
  if (compat.supportsThinkingTokenBudget) {
    return "thinking_token_budget";
  }
  return undefined;
}

/**
 * 计算按回答空间收敛后的思考 token 预算。
 * @param model - 请求模型，未设置请求上限时使用其 `maxTokens` 作为上限。
 * @param options - 请求选项，提供推理强度与自定义预算。
 * @param params - 已写入最大 token 字段的请求参数。
 * @returns 正数预算；未启用推理、模型不支持推理或收敛后预算不大于 0 时返回 undefined。
 */
function resolveClampedThinkingBudget(
  model: Model<"openai-completions">,
  options: OpenAICompletionsOptions | undefined,
  params: { max_tokens?: number | null; max_completion_tokens?: number | null },
): number | undefined {
  if (!options?.reasoningEffort || model.reasoning === false) {
    return undefined;
  }
  const ceiling = params.max_tokens ?? params.max_completion_tokens ?? model.maxTokens;
  const requestedBudget = thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets);
  const budget =
    ceiling === undefined
      ? requestedBudget
      : clampThinkingBudgetToAnswerRoom(requestedBudget, ceiling);
  return budget > 0 ? budget : undefined;
}

/**
 * 解析兼容配置中的 chat template 参数模板，生成实际请求值。
 * @param model - 请求模型，提供推理能力与推理等级映射。
 * @param options - 请求选项，提供推理强度。
 * @param values - 参数模板，值可以是字面量或 `{ $var }` 变量引用。
 * @param thinkingBudget - 已收敛的思考预算，用于替换 `thinking.budget` 变量。
 * @returns 解析后的参数对象；所有键都被省略时返回 undefined。
 */
function buildChatTemplateValues(
  model: Model<"openai-completions">,
  options: OpenAICompletionsOptions | undefined,
  values: Record<string, ChatTemplateKwargValue>,
  thinkingBudget?: number,
): Record<string, ResolvedChatTemplateKwargValue> | undefined {
  const resolvedValues: Record<string, ResolvedChatTemplateKwargValue> = {};

  for (const [key, value] of Object.entries(values)) {
    const resolved = resolveChatTemplateKwargValue(model, options, value, thinkingBudget);
    if (resolved !== undefined) {
      resolvedValues[key] = resolved;
    }
  }

  return Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined;
}

/**
 * 解析单个 chat template 参数值。
 * @param model - 请求模型，提供推理能力与推理等级映射。
 * @param options - 请求选项，提供推理强度。
 * @param value - 字面量值或变量引用。
 * @param thinkingBudget - 已收敛的思考预算。
 * @returns 字面量原样返回；`thinking.enabled` 返回是否启用推理；`thinking.budget` 返回思考预算；其他变量返回映射后的推理等级字符串（无映射时返回原推理强度）。返回 undefined 表示省略该键，发生于：未启用推理且变量设置了 `omitWhenOff` 或模型未声明推理能力；或映射值不是字符串。
 */
function resolveChatTemplateKwargValue(
  model: Model<"openai-completions">,
  options: OpenAICompletionsOptions | undefined,
  value: ChatTemplateKwargValue,
  thinkingBudget?: number,
): ResolvedChatTemplateKwargValue | undefined {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const reasoningEffort = options?.reasoningEffort;
  if (!reasoningEffort && (value.omitWhenOff || model.reasoning !== true)) {
    return undefined;
  }
  if (value.$var === "thinking.enabled") {
    return !!reasoningEffort;
  }
  if (value.$var === "thinking.budget") {
    return thinkingBudget;
  }

  const mappedValue = reasoningEffort
    ? model.thinkingLevelMap?.[reasoningEffort]
    : model.thinkingLevelMap?.off;
  return mappedValue === undefined
    ? reasoningEffort
    : typeof mappedValue === "string"
      ? mappedValue
      : undefined;
}

/**
 * 根据端点缓存格式与缓存保留策略生成 Anthropic 风格的缓存配置。
 * @param compat - 端点兼容配置。
 * @param cacheRetention - 已解析的缓存保留策略。
 * @returns ephemeral 缓存配置，长保留且端点支持时附带 `ttl: "1h"`；端点不使用 Anthropic 缓存格式或策略为 `none` 时返回 undefined。
 */
function getCompatCacheControl(
  compat: ResolvedOpenAICompletionsCompat,
  cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
  if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
    return undefined;
  }

  const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
  return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

/**
 * 为系统提示、最后一个工具和最后一条可缓存会话消息附加缓存配置。
 * @param messages - 请求消息，会被原地修改。
 * @param tools - 请求工具列表，会被原地修改；为空时跳过。
 * @param cacheControl - 要附加的缓存配置。
 */
function applyAnthropicCacheControl(
  messages: ChatCompletionMessageParam[],
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
  cacheControl: OpenAICompatCacheControl,
): void {
  addCacheControlToSystemPrompt(messages, cacheControl);
  addCacheControlToLastTool(tools, cacheControl);
  addCacheControlToLastConversationMessage(messages, cacheControl);
}

/**
 * 为第一条 system 或 developer 消息附加缓存配置。
 * @param messages - 请求消息，会被原地修改。
 * @param cacheControl - 要附加的缓存配置。
 */
function addCacheControlToSystemPrompt(
  messages: ChatCompletionMessageParam[],
  cacheControl: OpenAICompatCacheControl,
): void {
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      addCacheControlToTextContent(message, cacheControl);
      return;
    }
  }
}

/**
 * 从后向前为首条可缓存的会话消息附加缓存配置。
 * @param messages - 按会话顺序排列的请求消息，会原地修改其中的文本内容。
 * @param cacheControl - 要附加的缓存配置。
 * @throws 消息数组存在空位或包含 undefined 时抛出错误。
 */
function addCacheControlToLastConversationMessage(
  messages: ChatCompletionMessageParam[],
  cacheControl: OpenAICompatCacheControl,
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) {
      throw new Error(`Missing message at index ${i}`);
    }
    if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
      if (addCacheControlToTextContent(message, cacheControl)) {
        return;
      }
    }
  }
}

function addCacheControlToLastTool(
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
  cacheControl: OpenAICompatCacheControl,
): void {
  if (!tools || tools.length === 0) {
    return;
  }

  const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
  lastTool.cache_control = cacheControl;
}

/**
 * 为消息的最后一个文本内容附加缓存配置。
 * @param message - 待修改的消息，字符串内容会被原地改写为带缓存配置的文本块数组。
 * @param cacheControl - 要附加的缓存配置。
 * @returns 成功附加时返回 true；内容为空字符串、不是数组或数组中没有文本块时返回 false。
 */
function addCacheControlToTextContent(
  message:
    | ChatCompletionInstructionMessageParam
    | ChatCompletionAssistantMessageParam
    | ChatCompletionToolMessageParam
    | Extract<ChatCompletionMessageParam, { role: "user" }>,
  cacheControl: OpenAICompatCacheControl,
): boolean {
  const content = message.content;
  if (typeof content === "string") {
    if (content.length === 0) {
      return false;
    }
    message.content = [
      {
        type: "text",
        text: content,
        cache_control: cacheControl,
      },
    ] as ChatCompletionTextPartWithCacheControl[];
    return true;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (part?.type === "text") {
      const textPart = part as ChatCompletionTextPartWithCacheControl;
      textPart.cache_control = cacheControl;
      return true;
    }
  }

  return false;
}

/**
 * 将已按端点能力整理的会话转换为 Chat Completions 请求消息。
 * @param model - 请求模型，用于确定消息格式和工具调用标识符规则。
 * @param context - 已按端点系统消息能力整理的会话。
 * @param compat - 端点兼容能力配置。
 * @param options - 工具调用格式转换选项。
 * @param transcriptTools - 会话工具状态，默认根据端点能力从会话解析。
 * @returns 按会话顺序转换的请求消息；无消息时返回空数组。
 * @throws 消息数组存在空位或包含 undefined 时抛出错误；工具格式转换错误会向调用方传播。
 * @remarks 连续工具结果统一处理图片；必要时插入助手消息以满足端点的消息顺序要求。
 */
function convertMessages(
  model: Model<"openai-completions">,
  context: TranscriptContext,
  compat: ResolvedOpenAICompletionsCompat,
  options?: ConvertCompletionsMessagesOptions,
  transcriptTools: TranscriptTools = resolveTranscriptTools(
    context.messages,
    compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true,
  ),
): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];

  /**
   * 将工具调用 ID 规范化为 Chat Completions 可接受的格式。
   * @param id - 原始工具调用 ID，可能是 Responses API 的 `{call_id}|{item_id}` 形式。
   * @returns 含 `|` 时返回清洗字符后的组合 ID，超过 40 字符则以截断前缀加短哈希保持唯一；OpenAI 官方端点下超长 ID 截断为 40 字符；其余情况原样返回。
   */
  const normalizeToolCallId = (id: string): string => {
    // 处理 OpenAI Responses API 的 {call_id}|{id} 格式；id 可能超过 400 个字符并包含 +、/、=。提取并规范化 call_id，同时保留条目唯一性：同一轮的多个工具调用可能共享 call_id，但 item_id 不同，而 Chat Completions 要求工具调用 id 各不相同。
    if (id.includes("|")) {
      // 保留允许的字符，并截断为 OpenAI 要求的最多 40 个字符。
      const separatorIndex = id.indexOf("|");
      const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
      const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
      const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
      if (combinedId.length <= 40) {
        return combinedId;
      }
      const hash = shortHash(id).slice(0, 8);
      const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
      return `${prefix}_${hash}`;
    }

    if (model.baseUrl.includes("api.openai.com") && id.length > 40) {
      return id.slice(0, 40);
    }
    return id;
  };

  const transformedMessages = transformMessages(context.messages, model, (id: string): string =>
    normalizeToolCallId(id),
  );
  const instructionRole =
    model.reasoning === true && compat.supportsDeveloperRole ? "developer" : "system";

  let lastRole: string | null = null;

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (msg === undefined) {
      throw new Error(`Missing message at index ${i}`);
    }
    // 部分提供商不允许用户消息紧跟工具结果，因此插入合成助手消息衔接。
    if (
      compat.requiresAssistantAfterToolResult &&
      lastRole === "toolResult" &&
      msg.role === "user"
    ) {
      params.push({
        role: "assistant",
        content: "I have processed the tool results.",
      });
    }

    if (msg.role === "system") {
      const addedTools =
        i > 0 && transcriptTools.isAnchoringAdditions ? (msg.toolsAdded ?? []) : [];
      if (addedTools.length > 0) {
        const toolMessage: ToolSystemMessageParam = {
          role: "system",
          tools: convertTools(addedTools, compat),
        };
        params.push(toolMessage as unknown as ChatCompletionMessageParam);
      }
      const text = i === 0 ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
      if (text.length > 0) {
        params.push({ role: instructionRole, content: sanitizeSurrogates(text) });
      }
    } else if (msg.role === "user") {
      if (typeof msg.content === "string") {
        params.push({
          role: "user",
          content: sanitizeSurrogates(msg.content),
        });
      } else {
        const content: ChatCompletionContentPart[] = msg.content
          .filter(
            (item: ImageContent | TextContent): boolean =>
              item.type !== "text" || item.text.length > 0,
          )
          .map((item: ImageContent | TextContent): ChatCompletionContentPart => {
            if (item.type === "text") {
              return {
                type: "text",
                text: sanitizeSurrogates(item.text),
              } satisfies ChatCompletionContentPartText;
            } else {
              return {
                type: "image_url",
                image_url: {
                  url: `data:${item.mimeType};base64,${item.data}`,
                },
              } satisfies ChatCompletionContentPartImage;
            }
          });
        if (content.length === 0) {
          continue;
        }
        params.push({
          role: "user",
          content,
        });
      }
    } else if (msg.role === "assistant") {
      // 部分提供商不接受 null 内容，改用空字符串。
      const assistantMsg: ChatCompletionAssistantMessageParamWithReasoning = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null,
      };

      const textBlocks = msg.content.filter(isTextContentBlock);
      const assistantTextParts = textBlocks
        .filter((block: TextContent): boolean => block.text.trim().length > 0)
        .map(
          (block: TextContent): ChatCompletionContentPartText =>
            ({
              type: "text",
              text: sanitizeSurrogates(block.text),
            }) satisfies ChatCompletionContentPartText,
        );
      const assistantText = assistantTextParts
        .map((part: ChatCompletionContentPartText): string => part.text)
        .join("");

      const thinkingBlocks = msg.content.filter(
        (block: TextContent | ThinkingContent | ToolCall): block is ThinkingContent =>
          block.type === "thinking",
      );
      const toolCalls = msg.content.filter(
        (block: TextContent | ThinkingContent | ToolCall): block is ToolCall =>
          block.type === "toolCall",
      );
      const preservedReasoningDetails = thinkingBlocks
        .map((block: ThinkingContent): OpenAIReasoningDetail[] | undefined =>
          parseOpenAIReasoningDetails(block.thinkingSignature),
        )
        .find(
          (details: OpenAIReasoningDetail[] | undefined): details is OpenAIReasoningDetail[] =>
            details !== undefined,
        );

      const nonEmptyThinkingBlocks = thinkingBlocks.filter(
        (block: ThinkingContent): boolean => block.thinking.trim().length > 0,
      );
      if (nonEmptyThinkingBlocks.length > 0) {
        if (compat.requiresThinkingAsText) {
          // 将思考块转换为普通文本，不添加标签以避免模型模仿。
          const thinkingText = nonEmptyThinkingBlocks
            .map((block: ThinkingContent): string => sanitizeSurrogates(block.thinking))
            .join("\n\n");
          assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
        } else {
          // 按 OpenAI Chat Completions 标准使用字符串发送助手内容。{type:"text", text:"..."} 数组并非标准助手格式，会使部分模型（例如 NVIDIA NIM 上的 DeepSeek V3.2）照搬内容块结构，产生 [{'type':'text','text':'[{...}]'}] 一类递归嵌套输出。
          if (assistantText.length > 0) {
            assistantMsg.content = assistantText;
          }

          // reasoning_details 是原始推理字段的结构化替代形式。
          if (!preservedReasoningDetails) {
            // 有可用签名时，采用首个思考块的签名，兼容 llama.cpp 与 gpt-oss。
            const signature = nonEmptyThinkingBlocks[0]?.thinkingSignature;
            if (signature && isOpenAICompletionsReasoningField(signature)) {
              assistantMsg[signature] = nonEmptyThinkingBlocks
                .map((block: ThinkingContent): string => block.thinking)
                .join("\n");
            }
          }
        }
      } else if (assistantText.length > 0) {
        // 按 OpenAI Chat Completions 标准使用字符串发送助手内容。{type:"text", text:"..."} 数组并非标准助手格式，会使部分模型（例如 NVIDIA NIM 上的 DeepSeek V3.2）照搬内容块结构，产生 [{'type':'text','text':'[{...}]'}] 一类递归嵌套输出。
        assistantMsg.content = assistantText;
      }

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc: ToolCall): ChatCompletionMessageToolCall => {
          const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);
          if (customInputProperty !== undefined) {
            return {
              id: tc.id,
              type: "custom",
              custom: {
                name: tc.name,
                input: sanitizeSurrogates(
                  getGrammarToolInput(tc.name, tc.arguments, customInputProperty),
                ),
              },
            };
          }
          return {
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          };
        });
      }
      if (preservedReasoningDetails) {
        assistantMsg.reasoning_details = preservedReasoningDetails;
      }
      if (
        compat.requiresReasoningContentOnAssistantMessages &&
        model.reasoning !== false &&
        assistantMsg.reasoning_content === undefined
      ) {
        assistantMsg.reasoning_content = "";
      }
      // 跳过既无内容也无工具调用的助手消息，处理在输出前就中断的响应。部分提供商要求 content 或 tool_calls 至少存在一个，其他提供商也不接受空助手消息。
      const content = assistantMsg.content;
      const hasContent = content !== null && content !== undefined && content.length > 0;
      if (!hasContent && !assistantMsg.tool_calls) {
        continue;
      }
      params.push(assistantMsg);
    } else if (msg.role === "toolResult") {
      const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
      let j = i;

      for (; j < transformedMessages.length; j++) {
        const toolMsg = transformedMessages[j];
        if (toolMsg === undefined) {
          throw new Error(`Missing message at index ${j}`);
        }
        if (toolMsg.role !== "toolResult") {
          break;
        }

        // 提取文本和图片内容。
        const textBlocks = toolMsg.content.filter(isTextContentBlock);
        const textResult = textBlocks.map((block: TextContent): string => block.text).join("\n");
        const hasImages = toolMsg.content.some(
          (c: ImageContent | TextContent): c is ImageContent => c.type === "image",
        );

        // 工具结果始终包含文本；仅有图片时添加占位文本。
        const hasText = textResult.length > 0;
        const toolResultText = hasText
          ? textResult
          : hasImages
            ? "(see attached image)"
            : "(no tool output)";
        // 部分提供商要求工具结果包含 name 字段。
        const toolResultMsg: ChatCompletionToolMessageParam = {
          role: "tool",
          content: sanitizeSurrogates(toolResultText),
          tool_call_id: toolMsg.toolCallId,
        };
        if (compat.requiresToolResultName && toolMsg.toolName) {
          Object.assign(toolResultMsg, { name: toolMsg.toolName });
        }
        params.push(toolResultMsg);

        if (hasImages && model.input?.includes("image") !== false) {
          for (const block of toolMsg.content) {
            if (block.type === "image") {
              imageBlocks.push({
                type: "image_url",
                image_url: {
                  url: `data:${block.mimeType};base64,${block.data}`,
                },
              });
            }
          }
        }
      }

      i = j - 1;

      if (imageBlocks.length > 0) {
        if (compat.requiresAssistantAfterToolResult) {
          params.push({
            role: "assistant",
            content: "I have processed the tool results.",
          });
        }

        params.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Attached image(s) from tool result:",
            },
            ...imageBlocks,
          ],
        });
        lastRole = "user";
      } else {
        lastRole = "toolResult";
      }

      continue;
    }

    lastRole = msg.role;
  }

  return params;
}

/**
 * 将工具定义转换为 Chat Completions 工具参数。
 * @param tools - 待转换的工具定义。
 * @param compat - 端点兼容配置，决定是否使用 grammar 自定义工具与 strict 模式。
 * @returns 转换后的工具列表；可使用 grammar 约束的工具转为 custom 工具，其余转为 function 工具。
 * @remarks 端点支持 strict 模式时才写入 `strict` 字段，其值表示是否得到了严格 JSON Schema。
 */
function convertTools(
  tools: Tool[],
  compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool: Tool): OpenAI.Chat.Completions.ChatCompletionTool => {
    const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
    if (grammar) {
      return {
        type: "custom",
        custom: {
          name: tool.name,
          description: tool.description,
          format: {
            type: "grammar",
            grammar: {
              syntax: grammar.format,
              definition: grammar.definition,
            },
          },
        },
      };
    }

    const strictParameters = resolveStrictJsonSchema(tool, compat.supportsStrictMode !== false);
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: strictParameters ?? (tool.parameters as Record<string, unknown>),
        // 仅在提供商支持时发送 strict，避免未知字段被拒绝。
        ...(compat.supportsStrictMode !== false && { strict: strictParameters !== undefined }),
      },
    };
  });
}

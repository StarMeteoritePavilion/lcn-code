import OpenAI from "openai";
import type { Stream } from "openai/core/streaming.mjs";
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
  ResponseOutputRefusal,
  ResponseOutputText,
  ResponseReasoningItem,
  ResponseStreamEvent,
  ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
  Api,
  AssistantMessage,
  CacheRetention,
  ImageContent,
  Model,
  OpenAIResponsesCompat,
  RequestHeaders,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  StreamOptions,
  SystemMessage,
  TextContent,
  TextSignatureV1,
  ThinkingContent,
  Tool,
  ToolCall,
  TranscriptContext,
  Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { retryRequest } from "../utils/request-retry.ts";
import { resolveCacheRetention } from "../utils/cache-retention.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
  getDeclaredTools,
  resolveTranscript,
  resolveTranscriptTools,
} from "../utils/transcript.ts";
import {
  appendGrammarToolInputJsonDelta,
  createGrammarToolInputProperties,
  type GrammarToolInputJsonBuffer,
  getGrammarToolInput,
  makeStrictJsonSchema,
  resolveGrammarConstrainedSampling,
  resolveStrictJsonSchema,
} from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

// OpenAI Responses 拒绝小于 16 的 max_output_tokens，见 https://github.com/earendil-works/pi/issues/6265 。
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

type PromptCacheOptions = { mode: "explicit" } | { ttl: "30m" };

/**
 * 合并模型兼容配置与默认值，得到完整的端点兼容能力。
 * @param model - 目标模型。
 * @returns 所有字段均已填充的兼容配置；未指定会话亲和格式时，openrouter.ai 地址使用 `openrouter`，其余使用 `openai`。
 */
function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
  return {
    supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
    supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
    sessionAffinityFormat:
      model.compat?.sessionAffinityFormat ??
      (model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai"),
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
    supportsStrictMode: model.compat?.supportsStrictMode ?? false,
    supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
    supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
    supportsToolSearch: model.compat?.supportsToolSearch ?? false,
    supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
    supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
  };
}

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

// OpenAI Responses 专属选项。
export interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * 发起 OpenAI Responses 请求，并将响应转换为助手消息事件流。
 * @param model - 请求的目标模型及端点兼容配置。
 * @param context - 待发送的会话上下文。
 * @param options - API 密钥、请求参数和生命周期回调。
 * @returns 立即返回的助手消息事件流，响应内容随后异步写入。
 * @remarks 会发起网络请求；请求和响应处理中的错误通过错误事件报告。
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
  model: Model<"openai-responses">,
  context: TranscriptContext,
  options: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();
  const compat = getCompat(model);
  const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);

  // 启动异步处理。
  (async (): Promise<void> => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api as Api,
      baseUrl: model.baseUrl,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      // 创建 OpenAI 客户端。
      const apiKey = options?.apiKey;
      if (typeof apiKey !== "string" || !apiKey.trim()) {
        throw new Error("apiKey must be a non-empty string");
      }
      const cacheRetention = resolveCacheRetention(options.cacheRetention, options.env);
      const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
      const grammarToolInputProperties = createGrammarToolInputProperties(
        getDeclaredTools(normalizedContext.messages),
        compat.supportsOpenAIGrammarTools,
      );
      const client = createClient(
        model,
        apiKey,
        compat,
        options.headers,
        options.fetch,
        cacheSessionId,
      );
      let params = buildParams(
        model,
        normalizedContext,
        options,
        compat,
        grammarToolInputProperties,
      );
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as ResponseCreateParamsStreaming;
      }
      const requestOptions = {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        maxRetries: 0,
      };
      const { data: openaiStream, response } = await retryRequest(
        (): Promise<{
          data: Stream<OpenAI.Responses.ResponseStreamEvent>;
          response: Response;
          request_id: string | null;
        }> => client.responses.create(params, requestOptions).withResponse(),
        {
          maxRetries: options?.maxRetries,
          maxRetryDelayMs: options?.maxRetryDelayMs,
          signal: options?.signal,
        },
      );
      await options?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );
      stream.push({ type: "start", partial: output });

      await processResponsesStream(openaiStream, output, stream, model, {
        onStreamEvent: options?.onStreamEvent,
        onProviderStreamEvent: options?.onProviderStreamEvent,
        grammarToolInputProperties,
        serviceTier: options?.serviceTier,
        /**
         * 按当前模型与服务等级更新用量费用。
         * @param usage - 要更新费用的用量对象。
         * @param serviceTier - 响应返回的服务等级，可为空或未提供。
         * @remarks 就地修改 usage.cost。
         */
        applyServiceTierPricing: (usage: Usage, serviceTier: string | null | undefined): void =>
          applyServiceTierPricing(usage, serviceTier, model),
      });

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "pending") {
        throw new Error("OpenAI Responses stream ended without a stop reason");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // 流式临时缓冲区仅用于解析，不得持久化。
        delete (block as { partialJson?: string }).partialJson;
        delete (block as { customInput?: unknown }).customInput;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatProviderError(
        normalizeProviderError(error),
        "OpenAI Responses API error",
      );
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

/**
 * 使用通用简化选项发起 OpenAI Responses 流式请求。
 * @param model - 请求的目标模型。
 * @param context - 待发送的会话上下文。
 * @param options - 通用流式选项，推理等级会按模型能力限制。
 * @returns 立即返回的助手消息事件流，响应内容随后异步写入。
 * @remarks 推理等级限制后为 `off` 时不设置 reasoningEffort；其余行为同 {@link stream}。
 */
export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
  model: Model<"openai-responses">,
  context: TranscriptContext,
  options: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const base = {
    ...buildBaseOptions(model, context, options),
    toolChoice: options?.toolChoice,
  } satisfies OpenAIResponsesOptions;
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

  return stream(model, context, {
    ...base,
    reasoningEffort,
  } satisfies OpenAIResponsesOptions);
};

/**
 * 创建 OpenAI SDK 客户端，并合并默认、模型、会话亲和与调用方请求头。
 * @param model - 提供基础地址和模型级请求头的目标模型。
 * @param apiKey - 用于 Bearer 鉴权的 API 密钥。
 * @param compat - 决定会话亲和请求头格式的兼容配置。
 * @param optionsHeaders - 调用方请求头，最后合并以覆盖默认值。
 * @param fetch - 自定义 fetch 实现。
 * @param sessionId - 会话标识；提供时按端点格式写入会话亲和请求头。
 * @returns 配置完成的 OpenAI 客户端。
 * @remarks 会清除组织、项目及 `x-api-key`/`api-key` 请求头，并强制设置 authorization。
 */
function createClient(
  model: Model<"openai-responses">,
  apiKey: string,
  compat: Required<OpenAIResponsesCompat>,
  optionsHeaders?: RequestHeaders,
  fetch?: typeof globalThis.fetch,
  sessionId?: string,
): OpenAI {
  const headers: RequestHeaders = {
    "User-Agent": getPiUserAgent(),
    "OpenAI-Organization": null,
    "OpenAI-Project": null,
    ...model.headers,
  };

  if (sessionId) {
    if (compat.sessionAffinityFormat === "openrouter") {
      headers["x-session-id"] = sessionId;
    } else {
      if (compat.sessionAffinityFormat === "openai") {
        headers.session_id = sessionId;
      }
      headers["x-client-request-id"] = sessionId;
    }
  }

  // 最后合并 options 请求头，使其能够覆盖默认值。
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  return new OpenAI({
    apiKey,
    adminAPIKey: null,
    organization: null,
    project: null,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    fetch,
    defaultHeaders: {
      ...headers,
      authorization: `Bearer ${apiKey}`,
      "x-api-key": null,
      "api-key": null,
    },
  });
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
function buildParams(
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

/**
 * 将消息标识和阶段编码为 V1 文本签名 JSON 字符串。
 * @param id - Responses 输出消息标识。
 * @param phase - 消息阶段；为空时不写入。
 * @returns 序列化后的签名字符串。
 */
function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
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

interface OpenAIResponsesStreamOptions {
  onStreamEvent?: StreamOptions["onStreamEvent"];
  onProviderStreamEvent?: StreamOptions["onProviderStreamEvent"];
  grammarToolInputProperties?: ReadonlyMap<string, string>;
  serviceTier?: string | null;
  applyServiceTierPricing?: (usage: Usage, serviceTier: string | null | undefined) => void;
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

// =============================================================================
// 流式响应处理。

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
async function processResponsesStream(
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
          jsonBuffer: { input: "", started: false, closed: false },
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
    options?.applyServiceTierPricing?.(output.usage, response?.service_tier ?? options.serviceTier);
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

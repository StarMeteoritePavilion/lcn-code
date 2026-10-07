import { type Static, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import type { ApiStreamOptions, SimpleStreamOptions } from "../llm-api/types.ts";

const STRING = Type.String();
const NONEMPTY_STRING = Type.String({ minLength: 1 });
const NUMBER = Type.Number();
const BOOLEAN = Type.Boolean();
const NULL = Type.Null();
const UNKNOWN = Type.Unknown();
const OPTIONAL_STRING = Type.Optional(STRING);
const OPTIONAL_NONEMPTY_STRING = Type.Optional(NONEMPTY_STRING);
const OPTIONAL_NUMBER = Type.Optional(NUMBER);
const OPTIONAL_BOOLEAN = Type.Optional(BOOLEAN);
const STRING_ARRAY = Type.Array(STRING);
const OPTIONAL_STRING_ARRAY = Type.Optional(STRING_ARRAY);
const UNKNOWN_RECORD = Type.Record(STRING, UNKNOWN);
const OPTIONAL_UNKNOWN_RECORD = Type.Optional(UNKNOWN_RECORD);
const STRING_RECORD = Type.Record(STRING, STRING);
const STRING_OR_NULL = Type.Union([STRING, NULL]);
const HEADERS = Type.Record(STRING, STRING_OR_NULL);
const OPTIONAL_HEADERS = Type.Optional(HEADERS);

const API = Type.Enum(["anthropic-messages", "openai-completions", "openai-responses"]);
const THINKING_LEVEL = Type.Enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
const THINKING_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const OPTIONAL_STRING_OR_NULL = Type.Optional(STRING_OR_NULL);
const THINKING_MAP_ENTRIES = THINKING_KEYS.map(
  (key: string): [string, typeof OPTIONAL_STRING_OR_NULL] => [key, OPTIONAL_STRING_OR_NULL],
);
const THINKING_MAP_PROPERTIES = Object.fromEntries(THINKING_MAP_ENTRIES);
const THINKING_LEVEL_MAP = Type.Object(THINKING_MAP_PROPERTIES);
const SAMPLING_MAP_ENTRIES = THINKING_KEYS.map(
  (key: string): [string, typeof OPTIONAL_UNKNOWN_RECORD] => [key, OPTIONAL_UNKNOWN_RECORD],
);
const SAMPLING_MAP_PROPERTIES = Object.fromEntries(SAMPLING_MAP_ENTRIES);
const SAMPLING_BY_THINKING_LEVEL = Type.Object(SAMPLING_MAP_PROPERTIES);
const THINKING_BUDGETS = Type.Object({
  minimal: OPTIONAL_NUMBER,
  low: OPTIONAL_NUMBER,
  medium: OPTIONAL_NUMBER,
  high: OPTIONAL_NUMBER,
});
const CACHE_RETENTION = Type.Enum(["none", "short", "long"]);
const POSITIVE_NUMBER = Type.Number({ exclusiveMinimum: 0 });
const PROMPT_CACHE = Type.Object({
  short: Type.Optional(POSITIVE_NUMBER),
  long: Type.Optional(POSITIVE_NUMBER),
});
const COST_RATES = { input: NUMBER, output: NUMBER, cacheRead: NUMBER, cacheWrite: NUMBER };
const COST_TIER = Type.Object({ inputTokensAbove: NUMBER, ...COST_RATES });
const COST_TIERS = Type.Array(COST_TIER);
const COST = Type.Object({ ...COST_RATES, tiers: Type.Optional(COST_TIERS) });
const POSITIVE_INTEGER = Type.Integer({ minimum: 1 });
const OPTIONAL_POSITIVE_INTEGER = Type.Optional(POSITIVE_INTEGER);
const JPEG_QUALITY = Type.Integer({ minimum: 1, maximum: 100 });
const IMAGE_RESIZE = Type.Object({
  maxWidth: OPTIONAL_POSITIVE_INTEGER,
  maxHeight: OPTIONAL_POSITIVE_INTEGER,
  maxBytes: OPTIONAL_POSITIVE_INTEGER,
  jpegQuality: Type.Optional(JPEG_QUALITY),
});
const IMAGE_LIMITS = Type.Object({
  resize: Type.Optional(IMAGE_RESIZE),
  maxPerMessage: OPTIONAL_POSITIVE_INTEGER,
  maxPerRequest: OPTIONAL_POSITIVE_INTEGER,
});
const INPUT_LIMITS = Type.Object({
  maxRequestBytes: OPTIONAL_POSITIVE_INTEGER,
  images: Type.Optional(IMAGE_LIMITS),
});
const INPUT_TYPE = Type.Enum(["text", "image"]);
const INPUT_TYPES = Type.Array(INPUT_TYPE);
const CHAT_VARIABLE = Type.Enum(["thinking.enabled", "thinking.effort", "thinking.budget"]);
const CHAT_VARIABLE_OBJECT = Type.Object({ $var: CHAT_VARIABLE, omitWhenOff: OPTIONAL_BOOLEAN });
const CHAT_VALUE = Type.Union([STRING, NUMBER, BOOLEAN, NULL, CHAT_VARIABLE_OBJECT]);
const CHAT_VALUES = Type.Record(STRING, CHAT_VALUE);
const PERCENTILES = Type.Object({
  p50: OPTIONAL_NUMBER,
  p75: OPTIONAL_NUMBER,
  p90: OPTIONAL_NUMBER,
  p99: OPTIONAL_NUMBER,
});
const NUMBER_OR_PERCENTILES = Type.Union([NUMBER, PERCENTILES]);
const NUMBER_OR_STRING = Type.Union([NUMBER, STRING]);
const OPTIONAL_NUMBER_OR_STRING = Type.Optional(NUMBER_OR_STRING);
const DATA_COLLECTION = Type.Enum(["deny", "allow"]);
const ROUTING_SORT_OBJECT = Type.Object({
  by: OPTIONAL_STRING,
  partition: Type.Optional(STRING_OR_NULL),
});
const ROUTING_SORT = Type.Union([STRING, ROUTING_SORT_OBJECT]);
const MAX_PRICE = Type.Object({
  prompt: OPTIONAL_NUMBER_OR_STRING,
  completion: OPTIONAL_NUMBER_OR_STRING,
  image: OPTIONAL_NUMBER_OR_STRING,
  audio: OPTIONAL_NUMBER_OR_STRING,
  request: OPTIONAL_NUMBER_OR_STRING,
});
const OPENROUTER_ROUTING = Type.Object({
  allow_fallbacks: OPTIONAL_BOOLEAN,
  require_parameters: OPTIONAL_BOOLEAN,
  data_collection: Type.Optional(DATA_COLLECTION),
  zdr: OPTIONAL_BOOLEAN,
  enforce_distillable_text: OPTIONAL_BOOLEAN,
  order: OPTIONAL_STRING_ARRAY,
  only: OPTIONAL_STRING_ARRAY,
  ignore: OPTIONAL_STRING_ARRAY,
  quantizations: OPTIONAL_STRING_ARRAY,
  sort: Type.Optional(ROUTING_SORT),
  max_price: Type.Optional(MAX_PRICE),
  preferred_min_throughput: Type.Optional(NUMBER_OR_PERCENTILES),
  preferred_max_latency: Type.Optional(NUMBER_OR_PERCENTILES),
});
const VERCEL_ROUTING = Type.Object({ only: OPTIONAL_STRING_ARRAY, order: OPTIONAL_STRING_ARRAY });
const SESSION_AFFINITY = Type.Enum(["openai", "openai-nosession", "openrouter"]);
const MAX_TOKENS_FIELD = Type.Enum(["max_completion_tokens", "max_tokens"]);
const THINKING_FORMAT = Type.Enum([
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "baseten",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
]);
const THINKING_TOKEN_BUDGET_FIELD = Type.Enum([
  "thinking_token_budget",
  "thinking_budget",
  "thinking_budget_tokens",
]);
const ANTHROPIC_CACHE_CONTROL_FORMAT = Type.Literal("anthropic");
const OPENROUTER_SESSION_AFFINITY = Type.Literal("openrouter");
const COMPLETIONS_COMPAT_PROPERTIES = {
  openRouterRouting: Type.Optional(OPENROUTER_ROUTING),
  vercelGatewayRouting: Type.Optional(VERCEL_ROUTING),
  supportsStore: OPTIONAL_BOOLEAN,
  supportsDeveloperRole: OPTIONAL_BOOLEAN,
  supportsReasoningEffort: OPTIONAL_BOOLEAN,
  supportsUsageInStreaming: OPTIONAL_BOOLEAN,
  supportsFinishReason: OPTIONAL_BOOLEAN,
  maxTokensField: Type.Optional(MAX_TOKENS_FIELD),
  requiresToolResultName: OPTIONAL_BOOLEAN,
  requiresAssistantAfterToolResult: OPTIONAL_BOOLEAN,
  requiresThinkingAsText: OPTIONAL_BOOLEAN,
  requiresReasoningContentOnAssistantMessages: OPTIONAL_BOOLEAN,
  thinkingFormat: Type.Optional(THINKING_FORMAT),
  chatTemplateKwargs: Type.Optional(CHAT_VALUES),
  chatTemplateArgs: Type.Optional(CHAT_VALUES),
  zaiToolStream: OPTIONAL_BOOLEAN,
  thinkingTokenBudgetField: Type.Optional(THINKING_TOKEN_BUDGET_FIELD),
  supportsThinkingTokenBudget: OPTIONAL_BOOLEAN,
  supportsOpenAIGrammarTools: OPTIONAL_BOOLEAN,
  supportsMidConvoSystemMessages: OPTIONAL_BOOLEAN,
  supportsMidConvoToolAdditions: OPTIONAL_BOOLEAN,
  supportsStrictMode: OPTIONAL_BOOLEAN,
  cacheControlFormat: Type.Optional(ANTHROPIC_CACHE_CONTROL_FORMAT),
  sendSessionAffinityHeaders: OPTIONAL_BOOLEAN,
  sessionAffinityFormat: Type.Optional(SESSION_AFFINITY),
  supportsLongCacheRetention: OPTIONAL_BOOLEAN,
  vllmPriority: OPTIONAL_NUMBER,
};
const RESPONSES_COMPAT_PROPERTIES = {
  supportsDeveloperRole: OPTIONAL_BOOLEAN,
  supportsMidConvoSystemMessages: OPTIONAL_BOOLEAN,
  sessionAffinityFormat: Type.Optional(SESSION_AFFINITY),
  supportsLongCacheRetention: OPTIONAL_BOOLEAN,
  supportsStrictMode: OPTIONAL_BOOLEAN,
  supportsOpenAIGrammarTools: OPTIONAL_BOOLEAN,
  supportsAdditionalTools: OPTIONAL_BOOLEAN,
  supportsToolSearch: OPTIONAL_BOOLEAN,
  supportsExplicitPromptCacheMode: OPTIONAL_BOOLEAN,
  supportsMaxOutputTokens: OPTIONAL_BOOLEAN,
};
const FALLBACK_MODEL = Type.Object({ model: NONEMPTY_STRING, cost: Type.Optional(COST) });
const FALLBACK_MODELS = Type.Array(FALLBACK_MODEL);
const ANTHROPIC_COMPAT_PROPERTIES = {
  supportsEagerToolInputStreaming: OPTIONAL_BOOLEAN,
  supportsLongCacheRetention: OPTIONAL_BOOLEAN,
  sendSessionAffinityHeaders: OPTIONAL_BOOLEAN,
  sessionAffinityFormat: Type.Optional(OPENROUTER_SESSION_AFFINITY),
  supportsCacheControlOnTools: OPTIONAL_BOOLEAN,
  supportsTemperature: OPTIONAL_BOOLEAN,
  forceAdaptiveThinking: OPTIONAL_BOOLEAN,
  allowEmptySignature: OPTIONAL_BOOLEAN,
  supportsStrictTools: OPTIONAL_BOOLEAN,
  supportsMidConvoEffort: OPTIONAL_BOOLEAN,
  supportsMidConvoSystemMessages: OPTIONAL_BOOLEAN,
  supportsMidConvoToolChanges: OPTIONAL_BOOLEAN,
  allowedFallbackModels: Type.Optional(FALLBACK_MODELS),
};
const COMPAT = Type.Object({
  ...COMPLETIONS_COMPAT_PROPERTIES,
  ...RESPONSES_COMPAT_PROPERTIES,
  ...ANTHROPIC_COMPAT_PROPERTIES,
  sessionAffinityFormat: Type.Optional(SESSION_AFFINITY),
});
const TOOL_NAME = Type.Object({ name: STRING });
const TOOL_MODE = Type.Enum(["auto", "required"]);
const UNKNOWN_RECORD_ARRAY = Type.Array(UNKNOWN_RECORD);
const ALLOWED_TOOLS = Type.Object({ mode: TOOL_MODE, tools: UNKNOWN_RECORD_ARRAY });
const COMPLETIONS_FUNCTION_CHOICE = Type.Object({
  type: Type.Literal("function"),
  function: TOOL_NAME,
});
const COMPLETIONS_CUSTOM_CHOICE = Type.Object({ type: Type.Literal("custom"), custom: TOOL_NAME });
const COMPLETIONS_ALLOWED_CHOICE = Type.Object({
  type: Type.Literal("allowed_tools"),
  allowed_tools: ALLOWED_TOOLS,
});
const OPENAI_TOOL_CHOICE_STRING = Type.Enum(["none", "auto", "required"]);
const COMPLETIONS_TOOL_CHOICE = Type.Union([
  OPENAI_TOOL_CHOICE_STRING,
  COMPLETIONS_FUNCTION_CHOICE,
  COMPLETIONS_CUSTOM_CHOICE,
  COMPLETIONS_ALLOWED_CHOICE,
]);
const RESPONSES_NAMED_TYPE = Type.Enum(["function", "custom"]);
const RESPONSES_NAMED_CHOICE = Type.Object({ type: RESPONSES_NAMED_TYPE, name: STRING });
const RESPONSES_MCP_CHOICE = Type.Object({
  type: Type.Literal("mcp"),
  server_label: STRING,
  name: Type.Optional(STRING_OR_NULL),
});
const RESPONSES_BUILTIN_TYPE = Type.Enum([
  "file_search",
  "web_search_preview",
  "computer",
  "computer_use_preview",
  "computer_use",
  "web_search_preview_2025_03_11",
  "image_generation",
  "code_interpreter",
  "mcp",
  "apply_patch",
  "shell",
  "programmatic_tool_calling",
]);
const RESPONSES_BUILTIN_CHOICE = Type.Object({ type: RESPONSES_BUILTIN_TYPE });
const RESPONSES_ALLOWED_CHOICE = Type.Object({
  type: Type.Literal("allowed_tools"),
  mode: TOOL_MODE,
  tools: UNKNOWN_RECORD_ARRAY,
});
const RESPONSES_TOOL_CHOICE = Type.Union([
  OPENAI_TOOL_CHOICE_STRING,
  RESPONSES_NAMED_CHOICE,
  RESPONSES_MCP_CHOICE,
  RESPONSES_BUILTIN_CHOICE,
  RESPONSES_ALLOWED_CHOICE,
]);
const ANTHROPIC_TOOL_CHOICE_STRING = Type.Enum(["auto", "any", "none"]);
const ANTHROPIC_NAMED_CHOICE = Type.Object({ type: Type.Literal("tool"), name: STRING });
const ANTHROPIC_TOOL_CHOICE = Type.Union([ANTHROPIC_TOOL_CHOICE_STRING, ANTHROPIC_NAMED_CHOICE]);
const TOOL_CHOICE = Type.Union([
  COMPLETIONS_TOOL_CHOICE,
  RESPONSES_TOOL_CHOICE,
  ANTHROPIC_TOOL_CHOICE,
]);
const REASONING_SUMMARY_STRING = Type.Enum(["auto", "detailed", "concise"]);
const REASONING_SUMMARY = Type.Union([REASONING_SUMMARY_STRING, NULL]);
const SERVICE_TIER_STRING = Type.Enum([
  "auto",
  "default",
  "flex",
  "scale",
  "priority",
  "fast",
  "ultrafast",
]);
const SERVICE_TIER = Type.Union([SERVICE_TIER_STRING, NULL]);
const ANTHROPIC_EFFORT = Type.Enum(["low", "medium", "high", "xhigh", "max"]);
const THINKING_DISPLAY = Type.Enum(["summarized", "omitted"]);
const REQUEST_PROPERTIES = {
  apiKey: OPTIONAL_STRING,
  env: Type.Optional(STRING_RECORD),
  headers: OPTIONAL_HEADERS,
  timeoutMs: OPTIONAL_NUMBER,
  maxRetries: OPTIONAL_NUMBER,
  maxRetryDelayMs: OPTIONAL_NUMBER,
  temperature: OPTIONAL_NUMBER,
  samplingParams: OPTIONAL_UNKNOWN_RECORD,
  maxTokens: OPTIONAL_NUMBER,
  cacheRetention: Type.Optional(CACHE_RETENTION),
  sessionId: OPTIONAL_STRING,
  metadata: OPTIONAL_UNKNOWN_RECORD,
  reasoning: Type.Optional(THINKING_LEVEL),
  thinkingBudgets: Type.Optional(THINKING_BUDGETS),
  reasoningEffort: Type.Optional(THINKING_LEVEL),
  reasoningSummary: Type.Optional(REASONING_SUMMARY),
  serviceTier: Type.Optional(SERVICE_TIER),
  thinkingEnabled: OPTIONAL_BOOLEAN,
  thinkingBudgetTokens: OPTIONAL_NUMBER,
  effort: Type.Optional(ANTHROPIC_EFFORT),
  thinkingDisplay: Type.Optional(THINKING_DISPLAY),
  interleavedThinking: OPTIONAL_BOOLEAN,
  toolChoice: Type.Optional(TOOL_CHOICE),
};
const REQUEST_OPTIONS = Type.Object(REQUEST_PROPERTIES);
const MODEL = Type.Object({
  id: NONEMPTY_STRING,
  name: OPTIONAL_STRING,
  input: Type.Optional(INPUT_TYPES),
  inputLimits: Type.Optional(INPUT_LIMITS),
  cost: Type.Optional(COST),
  headers: OPTIONAL_HEADERS,
  reasoning: OPTIONAL_BOOLEAN,
  thinkingLevelMap: Type.Optional(THINKING_LEVEL_MAP),
  promptCache: Type.Optional(PROMPT_CACHE),
  contextWindow: Type.Optional(POSITIVE_NUMBER),
  maxTokens: Type.Optional(POSITIVE_NUMBER),
  samplingParams: OPTIONAL_UNKNOWN_RECORD,
  samplingParamsByThinkingLevel: Type.Optional(SAMPLING_BY_THINKING_LEVEL),
  compat: Type.Optional(COMPAT),
  requestOptions: Type.Optional(REQUEST_OPTIONS),
});
const MODELS = Type.Array(MODEL);
const PROVIDER = Type.Object({
  name: NONEMPTY_STRING,
  baseUrl: OPTIONAL_NONEMPTY_STRING,
  apiKey: OPTIONAL_NONEMPTY_STRING,
  api: Type.Optional(API),
  models: Type.Optional(MODELS),
  requestOptions: Type.Optional(REQUEST_OPTIONS),
});
const PROVIDERS = Type.Array(PROVIDER);
const AI_CONFIG = Type.Object({
  provider: NONEMPTY_STRING,
  model: NONEMPTY_STRING,
  modelProviders: PROVIDERS,
});
const CONFIG_VALIDATOR = Compile(AI_CONFIG);
const COMPLETIONS_COMPAT = Type.Object(COMPLETIONS_COMPAT_PROPERTIES);
const RESPONSES_COMPAT = Type.Object(RESPONSES_COMPAT_PROPERTIES);
const ANTHROPIC_COMPAT = Type.Object(ANTHROPIC_COMPAT_PROPERTIES);
const COMPLETIONS_REQUEST = Type.Object({
  ...REQUEST_PROPERTIES,
  toolChoice: Type.Optional(COMPLETIONS_TOOL_CHOICE),
});
const RESPONSES_REQUEST = Type.Object({
  ...REQUEST_PROPERTIES,
  toolChoice: Type.Optional(RESPONSES_TOOL_CHOICE),
});
const ANTHROPIC_REQUEST = Type.Object({
  ...REQUEST_PROPERTIES,
  toolChoice: Type.Optional(ANTHROPIC_TOOL_CHOICE),
});
const PROTOCOL_VALIDATORS = {
  "openai-completions": {
    compat: Compile(COMPLETIONS_COMPAT),
    request: Compile(COMPLETIONS_REQUEST),
  },
  "openai-responses": { compat: Compile(RESPONSES_COMPAT), request: Compile(RESPONSES_REQUEST) },
  "anthropic-messages": { compat: Compile(ANTHROPIC_COMPAT), request: Compile(ANTHROPIC_REQUEST) },
};

/** 配置文件可表达的协议请求参数；API 密钥由提供商注入。 */
export type AiRequestOptions =
  | (Omit<ApiStreamOptions<"anthropic-messages">, "apiKey"> &
      Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets">)
  | (Omit<ApiStreamOptions<"openai-completions">, "apiKey"> &
      Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets">)
  | (Omit<ApiStreamOptions<"openai-responses">, "apiKey"> &
      Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets">);

type ModelConfig = Omit<Static<typeof MODEL>, "requestOptions"> & {
  requestOptions?: AiRequestOptions;
};
type ProviderConfig = Omit<Static<typeof PROVIDER>, "models" | "requestOptions"> & {
  models?: ModelConfig[];
  requestOptions?: AiRequestOptions;
};

/** settings.json 中通过结构校验的 AI 配置；省略字段的默认值由模型解析与适配器处理。 */
export type AiConfig = Omit<Static<typeof AI_CONFIG>, "modelProviders"> & {
  modelProviders: ProviderConfig[];
};

/**
 * 将结构校验错误转换为字段路径，不包含配置值。
 * @param error - TypeBox 返回的校验错误。
 * @returns 使用点号分隔的字段路径，顶层错误返回 root。
 */
function validationPath(error: TLocalizedValidationError): string {
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  if (error.keyword !== "required") {
    return path || "root";
  }
  const properties = error.params as { requiredProperties?: string[] };
  const property = properties.requiredProperties?.[0];
  if (!property) {
    return path || "root";
  }
  return path ? `${path}.${property}` : property;
}

/**
 * 校验一个配置对象并输出不含配置值的错误。
 * @param validator - 已编译的结构校验器。
 * @param value - 待校验的对象。
 * @param prefix - 对象在配置中的字段路径。
 * @throws 结构不符合约定时抛出异常。
 */
function validateObject(
  validator: ReturnType<typeof Compile<TSchema>>,
  value: unknown,
  prefix: string,
): void {
  if (validator.Check(value)) {
    return;
  }
  const errors = validator.Errors(value);
  const messages = errors.map((error: TLocalizedValidationError): string => {
    const path = validationPath(error);
    const fullPath = prefix ? `${prefix}.${path}` : path;
    return `${fullPath}: ${error.keyword}`;
  });
  const details = messages.join("\n");
  throw new Error(`Configuration validation failed:\n${details}`);
}

/**
 * 校验配置结构及已声明协议的兼容配置与请求选项。
 * @param value - 通用配置读取器解析后的值。
 * @throws 配置字段的类型、枚举或取值范围不符合约定时抛出异常；异常不包含配置值。
 * @remarks 保留未知字段，沿用 Pi 的宽松字段策略；不填入默认值、不修改配置。
 */
export function validateAiConfig(value: unknown): asserts value is AiConfig {
  validateObject(CONFIG_VALIDATOR, value, "");
  const config = value as AiConfig;
  const providers = config.modelProviders ?? [];
  for (const [providerIndex, provider] of providers.entries()) {
    if (!provider.api) {
      continue;
    }
    const validators = PROTOCOL_VALIDATORS[provider.api];
    const prefix = `modelProviders.${providerIndex}`;
    if (provider.requestOptions) {
      validateObject(validators.request, provider.requestOptions, `${prefix}.requestOptions`);
    }
    const models = provider.models ?? [];
    for (const [modelIndex, model] of models.entries()) {
      const modelPrefix = `${prefix}.models.${modelIndex}`;
      if (model.compat) {
        validateObject(validators.compat, model.compat, `${modelPrefix}.compat`);
      }
      if (model.requestOptions) {
        validateObject(validators.request, model.requestOptions, `${modelPrefix}.requestOptions`);
      }
    }
  }
}

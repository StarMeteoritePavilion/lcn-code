import type { TSchema } from "typebox";
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";
export type Api = "anthropic-messages" | "openai-completions" | "openai-responses";

export type ToolChoice = "auto" | "none";
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
export type SamplingParams = Record<string, unknown>;
export type SamplingParamsByThinkingLevel = Partial<Record<ModelThinkingLevel, SamplingParams>>;
export type ChatTemplateKwargValue =
  | string
  | number
  | boolean
  | null
  | {
      $var: "thinking.enabled" | "thinking.effort" | "thinking.budget";
      omitWhenOff?: boolean;
    };

/** 在兼容 OpenAI 的服务端限制推理 token 数的顶层请求字段。 */
export type ThinkingTokenBudgetField =
  "thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens";

/** 各思考级别的 token 预算，仅用于支持 token 预算的协议。 */
export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

// 所有端点共享的基础选项。
export type CacheRetention = "none" | "short" | "long";

/**
 * 各缓存保留级别的提示缓存预期寿命，单位秒；缺少级别表示寿命未知。
 * 当前项目只保存此元数据，不执行缓存预热或修改协议缓存 TTL。
 */
export type ModelPromptCache = Partial<Record<Exclude<CacheRetention, "none">, number>>;

export type RequestHeaders = Record<string, string | null>;
export type RequestEnv = Record<string, string>;
export type FetchFunction = typeof globalThis.fetch;
export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

export interface OpenRouterRouting {
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "deny" | "allow";
  zdr?: boolean;
  order?: string[];
  only?: string[];
  ignore?: string[];
  [key: string]: unknown;
}

export interface VercelGatewayRouting {
  only?: string[];
  order?: string[];
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
}

/** 显式 API 密钥、HTTP 传输和请求生命周期回调。 */
export interface RequestOptions<TModel = Model> {
  apiKey: string;
  signal?: AbortSignal;
  env?: RequestEnv;
  fetch?: FetchFunction;
  /** 返回 undefined 时发送原始请求体。 */
  onPayload?: (payload: unknown, model: TModel) => unknown | Promise<unknown>;
  onResponse?: (response: HttpResponse, model: TModel) => void | Promise<void>;
  /** 额外请求头；认证头由 apiKey 管理，null 可移除其他默认请求头。 */
  headers?: RequestHeaders;
  /** HTTP 超时，单位毫秒；省略时使用 SDK 默认值。 */
  timeoutMs?: number;
  /** 响应体开始前的重试次数，默认为 0。 */
  maxRetries?: number;
  /** 服务端要求的最大重试等待，默认 60000 毫秒；0 表示不限制。 */
  maxRetryDelayMs?: number;
}

export interface StreamOptions extends RequestOptions {
  /** 在规范化前观察原生协议事件；应只读访问数据。 */
  onStreamEvent?: (data: unknown, model: Model) => void | Promise<void>;
  /** @deprecated 请使用 onStreamEvent。 */
  onProviderStreamEvent?: (data: unknown, model: Model) => void | Promise<void>;
  temperature?: number;
  /** 额外 OpenAI 请求采样字段，按键覆盖模型默认值。 */
  samplingParams?: SamplingParams;
  maxTokens?: number;
  /** 默认 short；请求或进程环境的 PI_CACHE_RETENTION 为 long 时采用 long。 */
  cacheRetention?: CacheRetention;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface ApiOptionsMap {
  "anthropic-messages": AnthropicOptions;
  "openai-completions": OpenAICompletionsOptions;
  "openai-responses": OpenAIResponsesOptions;
}

export type ApiStreamOptions<TApi extends Api> = ApiOptionsMap[TApi];

export interface AnthropicAllowedFallbackModel {
  model: string;
  cost?: ModelCost;
}

export interface SimpleStreamOptions extends StreamOptions {
  toolChoice?: ToolChoice;
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}

/** 内部适配器约定：接收公共入口规范化后的对话记录。 */
export type StreamFunction<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> = (
  model: Model<TApi>,
  context: TranscriptContext,
  options: TOptions,
) => AssistantMessageEventStream;

export interface TextSignatureV1 {
  v: 1;
  id: string;
  phase?: "commentary" | "final_answer";
}

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string; // 例如 OpenAI Responses 消息元数据：旧版 ID 字符串或 TextSignatureV1 JSON。
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string; // 协议专属的不透明或序列化推理重放数据。
  /**
   * 为 true 时表示思考内容已被安全过滤器隐藏；不透明加密内容保存在 thinkingSignature，
   * 可传回 API 以保持多轮对话连续性。
   */
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string; // Base64 编码的图片数据。
  mimeType: string; // 例如 "image/jpeg"、"image/png"。
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
  /** 调用动态加载或带命名空间工具时使用的 OpenAI Responses 命名空间。 */
  namespace?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheWrite 中采用 1 小时保留策略的写入量；仅 Anthropic 报告此细分。 */
  cacheWrite1h?: number;
  /**
   * 端点报告的推理或思考 token 数，是 output 的子集，output 已包含这些 token。
   * 提供推理用量明细的端点写入数值（包括 0）；其余端点不设置。
   */
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsExactlyJsonValue<T> = [T] extends [JsonValue]
  ? [JsonValue] extends [T]
    ? true
    : false
  : false;
type IsJsonProperty<T> =
  IsAny<T> extends true
    ? false
    : unknown extends T
      ? false
      : [Exclude<T, undefined>] extends [never]
        ? true
        : IsJsonCompatible<Exclude<T, undefined>>;
type InvalidJsonKeys<T extends object> = {
  [TKey in keyof T]-?: TKey extends string | number
    ? IsJsonProperty<T[TKey]> extends true
      ? never
      : TKey
    : TKey;
}[keyof T];
type IsJsonCompatible<T> =
  IsAny<T> extends true
    ? false
    : unknown extends T
      ? false
      : IsExactlyJsonValue<T> extends true
        ? true
        : T extends null | boolean | number | string
          ? true
          : T extends undefined
            ? false
            : T extends readonly (infer TItem)[]
              ? IsJsonCompatible<TItem>
              : T extends (...args: never[]) => unknown
                ? false
                : T extends object
                  ? [InvalidJsonKeys<T>] extends [never]
                    ? true
                    : false
                  : false;

/** 内存中带类型值的 JSON 表示；对象的可选属性保持可选。 */
export type JsonRepresentation<T> =
  IsAny<T> extends true
    ? JsonValue
    : unknown extends T
      ? JsonValue
      : [T] extends [JsonValue]
        ? T
        : T extends readonly unknown[]
          ? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
          : T extends object
            ? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
            : never;

/**
 * 对话记录中某一时刻的系统指令与工具声明；首条系统消息提供系统提示。
 * 后续消息的 content 追加指令，sections 替换或删除命名提示段，toolsAdded/toolsRemoved 更新工具集合。
 * 按顺序回放系统消息得到当前提示与工具；支持中途系统消息的端点逐条发送，
 * 其余端点按回放状态重建开头的系统消息。
 */
export interface SystemMessage {
  role: "system";
  /** 指令文本；首条消息为基础提示，后续消息为补充指令。 */
  content: string | TextContent[];
  /**
   * 命名且有顺序的提示段，原样渲染在 content 之后；首条消息声明，后续消息按名称替换，null 删除。
   * 每段应有独立边界（如标签或标题），方便模型对应更新；避免类整数名称，JSON 对象会重排这些键。
   */
  sections?: Record<string, string | null>;
  /** 从当前时刻起可用的工具完整定义。 */
  toolsAdded?: Tool[];
  /** 从当前时刻起不再可用的工具。 */
  toolsRemoved?: ToolReference[];
  timestamp: number; // Unix 时间戳，单位毫秒。
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number; // Unix 时间戳，单位毫秒。
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  baseUrl: string;
  model: string;
  responseModel?: string; // 端点报告的实际模型，与请求的 model 不同时记录。
  responseId?: string; // 上游 API 提供的协议专属响应或消息标识。
  /** 本次响应使用的端点原生 effort 级别；旧版或非托管响应不设置。 */
  thinkingEffort?: string;
  /** 代理循环为本次响应请求的 Pi 思考级别；代理循环外或旧版响应不设置。 */
  thinkingLevel?: ModelThinkingLevel;
  diagnostics?: AssistantMessageDiagnostic[]; // 失败与恢复过程中的脱敏端点或运行时诊断信息。
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  rawStopReason?: string;
  /** 端点报告的模型是否显式结束本轮；保留用于调试，当前不影响代理控制流程。 */
  endTurn?: boolean;
  timestamp: number; // Unix 时间戳，单位毫秒。
}

/** 工具执行期间发起的其他工具调用，例如 codemode 脚本中的调用。 */
export interface NestedToolCallRecord {
  id: string;
  name: string;
  /** 超出大小限制时省略，此时 argumentsBytes 记录大小。 */
  arguments?: JsonObject;
  /** 参数序列化为 JSON 后的 UTF-8 字节数，在 arguments 省略时设置。 */
  argumentsBytes?: number;
  /** unfinished 表示外层工具结束时，该调用仍在运行。 */
  status: "ok" | "error" | "unfinished";
  durationMs?: number;
  /** 经过截断的错误文本。 */
  error?: string;
}

/** 工具嵌套调用的有限记录，不记录执行结果。 */
export interface NestedToolCalls {
  calls: NestedToolCallRecord[];
  /** 调用被丢弃、参数被省略或调用未完成时为 false。 */
  complete: boolean;
}

export type ToolResultMessage<TDetails = JsonValue> =
  IsJsonCompatible<TDetails> extends true
    ? {
        role: "toolResult";
        toolCallId: string;
        toolName: string;
        content: (TextContent | ImageContent)[]; // 支持文本和图片。
        details?: JsonRepresentation<TDetails>;
        /** 工具执行本身的用量；可用时记录，不计入主模型上下文用量。 */
        usage?: Usage;
        /** 此工具对其他工具的调用；保留在会话记录中，不发送给模型。 */
        nestedCalls?: NestedToolCalls;
        isError: boolean;
        timestamp: number; // Unix 时间戳，单位毫秒。
      }
    : never;

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/** 用于受限采样的 OpenAI 文法格式。 */
export type GrammarFormat = "openai_lark" | "openai_regex";

export type GrammarVariants = Partial<Record<GrammarFormat, string>>;

/**
 * 工具可选的端点受限采样配置；json_schema 对应 API 的 strict 概念，由端点进行 JSON Schema 受限采样。
 * 文法格式允许调用方为同一目标语言提供协议专属编码。
 */
export type ConstrainedSamplingConfig =
  | {
      type: "json_schema";
      strict: "prefer" | "require";
    }
  | {
      type: "grammar";
      variants: GrammarVariants;
    };

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  constrainedSampling?: false | ConstrainedSamplingConfig;
}

export interface ToolReference {
  name: string;
}

/**
 * 公共流式入口（stream、streamSimple 等）接受的请求上下文。
 * systemPrompt 和 tools 是开头系统消息的简写，normalizeContext 在传给端点前将其合并。
 */
export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

declare const TRANSCRIPT_CONTEXT_BRAND: unique symbol;

/**
 * 传给端点与适配器的规范化上下文；提示和工具声明由系统消息承载。
 * 只有 normalizeContext 产生此类型，防止未经规范化的 Context 直接进入端点。
 */
export type TranscriptContext = {
  messages: Message[];
  readonly [TRANSCRIPT_CONTEXT_BRAND]: true;
};

/**
 * AssistantMessageEventStream 的事件协议：成功流先发 start，再发送内容更新，最后发 done。
 * 生成前准备失败可直接以 error 结束；start 后的失败也以 error 结束，更新和 done 不得先于 start。
 * partial 是共享的实时累积消息，不是事件时刻的快照；文本与思考块在 *_start 时为空，
 * 通过对应的 *_delta 增长，最终以 *_end 为准。隐藏的思考可在开始时完整存在且没有增量。
 * toolcall_start 的参数依协议而定，toolcall_delta 携带后续 JSON 更新。
 */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      message: AssistantMessage;
    }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/** 兼容 OpenAI Completions 的端点设置；显式配置实际端点能力。 */
export interface OpenAICompletionsCompat {
  openRouterRouting?: OpenRouterRouting;
  vercelGatewayRouting?: VercelGatewayRouting;
  /** 端点是否支持 store 字段；省略时使用协议默认值。 */
  supportsStore?: boolean;
  /** 端点是否支持 developer 角色而非 system；省略时使用协议默认值。 */
  supportsDeveloperRole?: boolean;
  /** 端点是否支持 reasoning_effort；省略时使用协议默认值。 */
  supportsReasoningEffort?: boolean;
  /** 端点是否支持 stream_options: { include_usage: true } 以报告流式 token 用量；默认 true。 */
  supportsUsageInStreaming?: boolean;
  /** 流式响应是否包含 finish_reason；为 false 时在流结束后推断 stop 或 toolUse，默认 true。 */
  supportsFinishReason?: boolean;
  /** 最大输出 token 数使用的字段；省略时使用协议默认值。 */
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  /** 工具结果是否要求 name 字段；省略时使用协议默认值。 */
  requiresToolResultName?: boolean;
  /** 工具结果之后的用户消息前是否要求插入助手消息；省略时使用协议默认值。 */
  requiresAssistantAfterToolResult?: boolean;
  /** 是否将思考块转换为带 <thinking> 分隔符的文本块；省略时使用协议默认值。 */
  requiresThinkingAsText?: boolean;
  /** 启用推理时，是否为重放的所有助手消息补充空 reasoning_content 字段；省略时使用协议默认值。 */
  requiresReasoningContentOnAssistantMessages?: boolean;
  /**
   * 推理参数格式，默认 openai：openai 使用 reasoning_effort，openrouter 使用 reasoning: { effort }；
   * deepseek 使用 thinking: { type }，together 使用 reasoning: { enabled }，支持时另发送 reasoning_effort；
   * baseten 使用配置的 chat_template_args，支持时另发送 reasoning_effort；zai 使用 thinking: { type }；
   * qwen 使用顶层 enable_thinking，qwen-chat-template 使用 chat_template_kwargs.enable_thinking 和 preserve_thinking；
   * chat-template 使用配置的 chat_template_kwargs，string-thinking 使用顶层字符串 thinking；
   * ant-ling 仅在映射后的 effort 非 null 时使用 reasoning: { effort }。
   */
  thinkingFormat?:
    | "openai"
    | "openrouter"
    | "deepseek"
    | "together"
    | "baseten"
    | "zai"
    | "qwen"
    | "chat-template"
    | "qwen-chat-template"
    | "string-thinking"
    | "ant-ling";
  /**
   * 当 thinkingFormat 为 chat-template 时发送的 chat_template_kwargs。
   * 使用 { "$var": "thinking.enabled" }、{ "$var": "thinking.effort" } 或 { "$var": "thinking.budget" }
   * 引用适配器计算的思考状态、强度或预算。
   */
  chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
  /**
   * 当 thinkingFormat 为 baseten 时发送的 chat_template_args。
   * 使用 { "$var": "thinking.enabled" }、{ "$var": "thinking.effort" } 或 { "$var": "thinking.budget" }
   * 引用适配器计算的思考状态、强度或预算。
   */
  chatTemplateArgs?: Record<string, ChatTemplateKwargValue>;
  /** 是否发送 z.ai 顶层 tool_stream: true 以获取工具调用增量；默认 false。 */
  zaiToolStream?: boolean;
  /**
   * 根据 thinkingBudgets 限制推理 token 的顶层请求字段，默认不设置。
   * 这些端点的推理与答案共享 max_tokens；没有独立预算时推理可能耗尽输出上限。
   * thinking_token_budget 用于 vLLM，thinking_budget 用于 Qwen/DashScope/SGLang，
   * thinking_budget_tokens 用于 llama.cpp；实际支持由端点决定。
   */
  thinkingTokenBudgetField?: ThinkingTokenBudgetField;
  /**
   * 用于 vLLM 的 thinkingTokenBudgetField: "thinking_token_budget" 别名。
   * 优先使用 thinkingTokenBudgetField；默认 false。
   */
  supportsThinkingTokenBudget?: boolean;
  /**
   * 端点是否支持 Lark/正则文法格式的 OpenAI 自定义工具；
   * 为 false 时文法工具回退为普通函数工具，默认 false。
   */
  supportsOpenAIGrammarTools?: boolean;
  /**
   * 模型是否接受对话开始后的 system 或 developer 消息；
   * 为 false 时后续系统消息折叠到开头，默认 false。
   */
  supportsMidConvoSystemMessages?: boolean;
  /** 系统消息是否可在对话中途引入工具；要求 supportsMidConvoSystemMessages，默认 false。 */
  supportsMidConvoToolAdditions?: boolean;
  /** 端点是否支持工具定义中的 strict 字段；默认 false。 */
  supportsStrictMode?: boolean;
  /**
   * 提示缓存控制格式；anthropic 将 Anthropic 风格的 cache_control 标记
   * 附加到系统提示、最后一个工具声明及最后一条用户、助手或工具结果文本内容。
   */
  cacheControlFormat?: "anthropic";
  /** 是否根据 options.sessionId 发送会话亲和信息；默认由协议探测规则决定。 */
  sendSessionAffinityHeaders?: boolean;
  /**
   * 会话亲和请求头格式：openai 发送 session_id、x-client-request-id 和 x-session-affinity；
   * openai-nosession 发送 x-client-request-id 和 x-session-affinity，openrouter 发送 x-session-id。
   * 不影响请求体 prompt_cache_key，该字段由缓存保留策略控制；省略时使用协议默认值。
   */
  sessionAffinityFormat?: SessionAffinityFormat;
  /**
   * 端点是否支持长提示缓存保留，按格式使用 prompt_cache_retention: "24h"
   * 或 Anthropic 风格的 cache_control.ttl: "1h"；省略时使用协议默认值。
   */
  supportsLongCacheRetention?: boolean;
  /**
   * 发送到顶层 priority 的 vLLM 调度优先级；较小值先处理，服务端默认 0。
   * 仅服务端使用 --scheduling-policy priority 时有意义，可用于减少后台/批处理对交互会话的阻塞；默认不发送。
   */
  vllmPriority?: number;
}

/** OpenAI Responses 端点的兼容配置。 */
export interface OpenAIResponsesCompat {
  /** 端点是否支持 developer 角色而非 system；默认 true。 */
  supportsDeveloperRole?: boolean;
  /**
   * 模型是否接受对话开始后的 developer 或 system 消息；
   * 为 false 时后续系统消息折叠到开头，默认 false。
   */
  supportsMidConvoSystemMessages?: boolean;
  /**
   * 会话亲和请求头格式：openai 发送 session_id 和 x-client-request-id；
   * openai-nosession 发送 x-client-request-id，openrouter 发送 x-session-id。
   * 不影响请求体 prompt_cache_key，该字段由缓存保留策略控制；省略时使用协议默认值。
   */
  sessionAffinityFormat?: SessionAffinityFormat;
  /**
   * 端点是否支持长提示缓存保留；默认 true。
   * 启用 supportsExplicitPromptCacheMode 时使用 prompt_cache_options.ttl: "30m"，否则使用 prompt_cache_retention: "24h"。
   */
  supportsLongCacheRetention?: boolean;
  /** 端点是否支持严格 JSON Schema 函数工具；默认行为由对应 API 决定。 */
  supportsStrictMode?: boolean;
  /**
   * 是否发送 Lark/正则文法格式的 OpenAI 自定义工具；
   * 为 false 时文法工具回退为普通函数工具，默认 false。
   */
  supportsOpenAIGrammarTools?: boolean;
  /** 模型是否支持按消息位置引入的 additional_tools 输入条目；默认 false。 */
  supportsAdditionalTools?: boolean;
  /** 模型是否支持通过客户端执行的工具搜索在对应消息位置新增工具；默认 false。 */
  supportsToolSearch?: boolean;
  /** 模型是否接受 prompt_cache_options；不支持该字段的端点会拒绝请求，默认 false。 */
  supportsExplicitPromptCacheMode?: boolean;
  /** 端点是否接受 max_output_tokens；部分 Codex 协议网关拒绝该字段，默认 true。 */
  supportsMaxOutputTokens?: boolean;
}

/** 兼容 Anthropic Messages 的端点配置。 */
export interface AnthropicMessagesCompat {
  /**
   * 端点是否接受每个工具的 eager_input_streaming；默认 true。
   * 为 false 时省略 tools[].eager_input_streaming，并为启用工具的请求发送
   * fine-grained-tool-streaming-2025-05-14 beta 请求头。
   */
  supportsEagerToolInputStreaming?: boolean;
  /** 端点是否支持 Anthropic 长缓存保留（cache_control.ttl: "1h"）；默认 true。 */
  supportsLongCacheRetention?: boolean;
  /**
   * 启用缓存时是否根据 options.sessionId 发送 x-session-affinity 请求头。
   * 用于要求会话亲和进行缓存路由的端点，使同一会话路由到同一副本；默认由协议探测规则决定。
   */
  sendSessionAffinityHeaders?: boolean;
  /** 会话亲和格式；openrouter 发送 x-session-id，未设置时发送 x-session-affinity。 */
  sessionAffinityFormat?: "openrouter";
  /**
   * 端点是否支持工具定义中的 Anthropic 风格 cache_control；默认 true。
   * 为 false 时从工具参数省略 cache_control；不支持该字段的兼容端点可能拒绝或忽略它。
   */
  supportsCacheControlOnTools?: boolean;
  /**
   * 模型是否接受 Anthropic temperature 请求字段；
   * 对于拒绝非默认温度的模型应设为 false，默认 true。
   */
  supportsTemperature?: boolean;
  /**
   * 端点要求自适应格式时，是否强制使用 thinking.type: "adaptive" 与 output_config.effort。
   * 需要自适应思考的模型应显式配置，默认 false。
   */
  forceAdaptiveThinking?: boolean;
  /** 是否以 signature: "" 重放空思考签名，而非将思考转换为文本；默认 false。 */
  allowEmptySignature?: boolean;
  /** 端点是否支持 Anthropic 严格工具 Schema；默认 false。 */
  supportsStrictTools?: boolean;
  /** 模型传输是否支持仅携带 effort 的系统消息与思考绑定控制；默认 false。 */
  supportsMidConvoEffort?: boolean;
  /**
   * 模型是否接受对话内部的 system 角色消息；
   * 为 false 时后续系统消息折叠到顶层系统提示，默认 false。
   */
  supportsMidConvoSystemMessages?: boolean;
  /**
   * 模型是否接受对话中途内联工具定义的 tool_addition 块
   * （inline-tools-2026-09-15）及 tool_removal 块；要求 supportsMidConvoSystemMessages，默认 false。
   */
  supportsMidConvoToolChanges?: boolean;
  /**
   * Anthropic 服务端拒绝回退使用的 fallbacks 模型，包含回退响应的本地计价元数据。
   * 缺少或为空时必须省略 fallbacks；没有获准回退目标的模型会拒绝该字段。
   */
  allowedFallbackModels?: AnthropicAllowedFallbackModel[];
}

export interface ModelCostRates {
  input: number; // 美元/百万 token。
  output: number; // 美元/百万 token。
  cacheRead: number; // 美元/百万 token。
  cacheWrite: number; // 美元/百万 token。
}

export interface ModelCostTier extends ModelCostRates {
  /** 总输入用量严格超过此 token 阈值时使用该档费率。 */
  inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
  /** 整个请求的阶梯价；匹配的最高输入阈值对应费率应用于整个请求。 */
  tiers?: ModelCostTier[];
}

export interface ModelImageResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** Base64 编码图片的最大字节数；当前仅保存配置，不执行限制。 */
  maxBytes?: number;
  jpegQuality?: number;
}

export interface ModelImageInputLimits {
  /** 新图片进入对话历史前的缩放配置；当前仅保存配置，不执行缩放。 */
  resize?: ModelImageResizeOptions;
  /** 单条端点消息的最大图片数；当前仅保存配置，不执行限制。 */
  maxPerMessage?: number;
  /** 单次端点请求的最大图片总数；当前仅保存配置，不执行限制。 */
  maxPerRequest?: number;
}

export interface ModelInputLimits {
  /** 序列化端点请求的最大字节数；当前仅保存配置，不执行限制。 */
  maxRequestBytes?: number;
  images?: ModelImageInputLimits;
}

/** 调用方管理的端点与模型配置；不执行模型发现，不依据提供商名称推断能力。 */
export interface Model<TApi extends Api = Api> {
  id: string;
  api: TApi;
  baseUrl: string;
  name?: string;
  /** 直接构造模型时省略此字段可透传文本与图片输入。 */
  input?: ("text" | "image")[];
  inputLimits?: ModelInputLimits;
  cost?: ModelCost;
  headers?: RequestHeaders;
  /** false 显式关闭推理；直接构造模型时省略此字段使用请求中的推理选项。 */
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  promptCache?: ModelPromptCache;
  /** 仅声明的有效上下文限制会约束简化请求的输出预算。 */
  contextWindow?: number;
  /** 省略时使用端点默认输出上限；Anthropic Messages 要求模型或请求选项提供此值。 */
  maxTokens?: number;
  samplingParams?: SamplingParams;
  samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
  compat?: TApi extends "openai-completions"
    ? OpenAICompletionsCompat
    : TApi extends "openai-responses"
      ? OpenAIResponsesCompat
      : AnthropicMessagesCompat;
}

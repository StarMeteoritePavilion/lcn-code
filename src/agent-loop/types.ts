import type { Static, TSchema } from "typebox";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ImageContent,
  JsonValue,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolResultMessage,
  TranscriptContext,
  Usage,
} from "../llm-api/index.ts";

/**
 * 为代理循环提供模型响应事件流。
 *
 * @param model - 本次请求使用的模型。
 * @param context - 规范化的对话记录。
 * @param options - 可选的流式请求配置。
 * @returns 响应事件流，或完成后得到该事件流的 Promise。
 * @remarks 系统提示词和工具声明通过对话记录中的系统消息传递，不使用 `context.systemPrompt` 或 `context.tools`。
 * 请求、模型或运行时失败不得通过抛出异常或拒绝 Promise 报告；必须通过流中的协议事件以及最终的
 * `AssistantMessage` 报告，最终消息的 `stopReason` 为 `"error"` 或 `"aborted"`，并设置 `errorMessage`。
 */
export type StreamFn = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * 规定同一条助手消息中工具调用的执行方式。
 *
 * - `"sequential"`：依次准备、执行并完成每个工具调用。
 * - `"parallel"`：按顺序准备工具调用，再并发执行获准的调用；完成每个调用后按完成顺序发出
 *   `tool_execution_end`，工具结果消息随后按助手消息中的原始顺序发出。
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * 规定代理循环读取消息队列时注入的用户消息数量。
 *
 * - `"all"`：读取并注入队列中的全部消息。
 * - `"one-at-a-time"`：仅读取并注入最早的消息，其余消息留待后续读取。
 */
export type QueueMode = "all" | "one-at-a-time";

/** 助手消息中单个工具调用的内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * `beforeToolCall` 返回的工具调用控制结果。
 *
 * 返回 `{ block: true }` 时阻止工具执行，循环改为发出错误工具结果。
 * `reason` 作为该结果的文本；省略时使用默认的阻止执行提示。
 */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  /**
   * 工具调用被阻止时，请求在当前工具批次结束后提前终止。
   * 只有批次中所有最终工具结果的 `terminate` 都为 `true` 时，才会提前终止。
   */
  terminate?: boolean;
}

/**
 * `afterToolCall` 返回的工具结果覆盖项。
 *
 * 逐字段替换，不进行深层合并：
 * - `content`：完整替换内容数组。
 * - `details`：完整替换详情。
 * - `isError`：替换错误标记。
 * - `usage`：替换用量。
 * - `terminate`：替换提前终止标记。
 * - `structuredContent`：替换结构化内容；提供 `content` 而未提供此字段时，丢弃原结构化内容，
 *   避免其与新内容不一致。需要保留时应同时返回此字段。
 *
 * 其余未提供的字段保留原执行结果。
 */
export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  structuredContent?: JsonValue;
  isError?: boolean;
  /** 工具最终执行产生的用量；不计入模型主要对话上下文的用量。 */
  usage?: Usage;
  /**
   * 请求在当前工具批次结束后提前终止。
   * 只有批次中所有最终工具结果的 `terminate` 都为 `true` 时，才会提前终止。
   */
  terminate?: boolean;
}

/** 传入 `beforeToolCall` 的上下文。 */
export interface BeforeToolCallContext {
  /** 发起工具调用的助手消息。 */
  assistantMessage: AssistantMessage;
  /** `assistantMessage.content` 中的原始工具调用块。 */
  toolCall: AgentToolCall;
  /** 已通过目标工具参数模式校验的参数。 */
  args: unknown;
  /** 准备工具调用时的代理上下文。 */
  context: AgentContext;
}

/** 传入 `afterToolCall` 的上下文。 */
export interface AfterToolCallContext {
  /** 发起工具调用的助手消息。 */
  assistantMessage: AssistantMessage;
  /** `assistantMessage.content` 中的原始工具调用块。 */
  toolCall: AgentToolCall;
  /** 已通过目标工具参数模式校验的参数。 */
  args: unknown;
  /** 应用 `afterToolCall` 覆盖项之前的工具执行结果。 */
  result: AgentToolResult<any>;
  /** 当前是否将工具执行结果视为错误。 */
  isError: boolean;
  /** 完成工具调用时的代理上下文。 */
  context: AgentContext;
}

/** 传入轮次完成回调的上下文。 */
export interface AgentTurnContext {
  /** 完成本轮的助手消息。 */
  message: AssistantMessage;
  /** 本轮产生的工具结果消息。 */
  toolResults: ToolResultMessage[];
  /** 追加本轮助手消息和工具结果消息后的代理上下文。 */
  context: AgentContext;
  /**
   * 本次循环在此处退出时返回的消息。
   * 从提示消息启动时包含初始提示消息；继续运行时不包含上下文中已有的消息。
   */
  newMessages: AgentMessage[];
}

/** {@link FinishTurn} 返回的调度决定；回调返回 `undefined` 时保留正常调度。 */
export type AgentTurnDecision = { action: "continue" } | { action: "end" };

/**
 * 在助手轮次及其工具结果处理完成后、发出 `turn_end` 之前决定后续调度。
 *
 * @param turn - 已完成轮次的消息、工具结果和当前上下文。
 * @param signal - 可选的取消信号。
 * @returns 调度决定，或完成后得到该决定的 Promise；无返回值或返回 `undefined` 时保留正常调度。
 * @throws 回调抛出异常或拒绝 Promise 时，循环会中断。
 * @remarks 正常轮次返回 `{ action: "continue" }` 时保证发起一次后续模型请求。
 * 工具结果、引导消息或后续消息的调度可满足该请求，不额外发起请求；否则使用当前上下文继续一次。
 * 返回 `{ action: "end" }` 时结束运行。错误响应和取消响应仍会直接退出。
 */
export type FinishTurn = (
  turn: AgentTurnContext,
  signal?: AbortSignal,
) => AgentTurnDecision | void | Promise<AgentTurnDecision | undefined> | Promise<void>;

/** 下一次模型请求前需要替换的运行时状态。 */
export interface AgentLoopTurnUpdate {
  /** 下一次模型请求使用的上下文。 */
  context?: AgentContext;
  /** 下一次模型请求前追加的消息；正常发出消息生命周期事件。 */
  messages?: AgentMessage[];
  /** 下一次模型请求使用的模型。 */
  model?: Model<any>;
  /** 下一次模型请求使用的推理级别。 */
  thinkingLevel?: ThinkingLevel;
}

/** 模型请求开始前可用的运行时状态。 */
export interface PrepareRequestContext {
  context: AgentContext;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
}

/** 当前准备中的模型请求需要替换的运行时状态。 */
export type AgentRequestUpdate = Omit<AgentLoopTurnUpdate, "messages">;

/**
 * 在每次模型请求开始前准备运行时状态，包括首次请求。
 *
 * @param request - 当前请求的上下文、模型和推理级别。
 * @param signal - 可选的取消信号。
 * @returns 替换状态，或完成后得到替换状态的 Promise；无返回值或返回 `undefined` 时保留当前状态。
 * @throws 回调抛出异常或拒绝 Promise 时，循环会中断。
 * @remarks 调用时，待处理消息已追加并发出对应事件；此回调不读取消息队列。
 * 返回的上下文、模型和推理级别用于当前请求及本次运行中的后续请求。
 */
export type PrepareRequest = (
  request: PrepareRequestContext,
  signal?: AbortSignal,
) => AgentRequestUpdate | void | Promise<AgentRequestUpdate | undefined> | Promise<void>;

export interface PrepareNextTurnContext extends AgentTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<any>;

  /**
   * 在每次模型调用前将代理消息转换为模型可处理的消息。
   *
   * @param messages - 需要转换的代理消息。
   * @returns 模型消息数组，或完成后得到该数组的 Promise；应过滤模型无法处理的自定义消息。
   * @remarks 转换结果中的消息必须为系统消息、用户消息、助手消息或工具结果消息。
   * 不得抛出异常或拒绝 Promise；失败时应返回安全的回退值，避免中断循环的正常事件序列。
   * @example
   * ```typescript
   * convertToLlm: (messages: AgentMessage[]): Message[] => {
   *   return messages;
   * }
   * ```
   */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

  /**
   * 在 `convertToLlm` 之前变换代理消息，例如裁剪上下文或注入外部消息。
   *
   * @param messages - 当前代理消息数组。
   * @param signal - 可选的取消信号。
   * @returns Promise 完成后的代理消息数组。
   * @remarks 不得抛出异常或拒绝 Promise；失败时应返回原消息或其他安全的回退值。
   * @example
   * ```typescript
   * transformContext: async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
   *   return messages;
   * }
   * ```
   */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

  /**
   * 在助手消息和全部工具结果发出后、`turn_end` 之前决定后续调度。
   *
   * @param turn - 已完成轮次的上下文。
   * @param signal - 可选的取消信号。
   * @returns 调度决定或相应 Promise；无返回值或返回 `undefined` 时保留正常调度。
   * @throws 回调抛出异常或拒绝 Promise 时，循环会中断。
   * @remarks 返回 `{ action: "end" }` 时结束运行，不读取队列或准备下一次请求。
   * 正常轮次返回 `{ action: "continue" }` 时保证一次后续模型请求；已有调度可满足该请求，
   * 否则使用当前上下文继续一次。错误响应和取消响应仍会直接退出。
   */
  finishTurn?: FinishTurn;

  /**
   * 在每次模型请求开始前准备状态，包括首次请求。
   *
   * @param request - 当前请求的上下文、模型和推理级别。
   * @param signal - 可选的取消信号。
   * @returns 替换状态或相应 Promise；无返回值或返回 `undefined` 时保留当前状态。
   * @throws 回调抛出异常或拒绝 Promise 时，循环会中断。
   * @remarks 待处理消息已经追加。返回的上下文、模型和推理级别替换当前及后续请求的状态；不读取队列。
   */
  prepareRequest?: PrepareRequest;

  /**
   * 在循环继续时，于 `turn_end` 之后、下一轮开始之前准备下一轮状态。
   *
   * @param context - 已完成轮次的上下文。
   * @returns 替换状态及待追加消息，或完成后得到该结果的 Promise；返回 `undefined` 时保留当前上下文和配置。
   * @throws 回调抛出异常或拒绝 Promise 时，循环会中断。
   */
  prepareNextTurn?: (
    context: PrepareNextTurnContext,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

  /**
   * 获取运行过程中需要注入对话的引导消息。
   *
   * @returns Promise 完成后的引导消息数组；没有可用消息时返回空数组。
   * @remarks 当前助手轮次的工具调用完成后调用；`finishTurn` 结束运行时不调用。
   * 返回的消息在下一次模型调用前加入上下文，不跳过当前助手消息中的工具调用。
   * 不得抛出异常或拒绝 Promise。
   */
  getSteeringMessages?: () => Promise<AgentMessage[]>;

  /**
   * 获取代理原本将停止时需要继续处理的后续消息。
   *
   * @returns Promise 完成后的后续消息数组；没有可用消息时返回空数组。
   * @remarks 没有剩余工具调用且没有引导消息时调用；返回消息后将其加入上下文并继续一轮。
   * 不得抛出异常或拒绝 Promise。
   */
  getFollowUpMessages?: () => Promise<AgentMessage[]>;

  /**
   * 工具执行方式，默认值为 `"parallel"`。
   *
   * - `"sequential"`：依次执行工具调用。
   * - `"parallel"`：按顺序准备调用，再并发执行获准的工具；按完成顺序发出
   *   `tool_execution_end`，随后按助手消息中的原始顺序发出工具结果消息。
   */
  toolExecution?: ToolExecutionMode;

  /**
   * 在工具参数通过校验后、工具执行前控制本次调用。
   *
   * @param context - 助手消息、工具调用、已校验参数和当前代理上下文。
   * @param signal - 可选的取消信号，回调应响应此信号。
   * @returns Promise 完成后的控制结果；返回 `undefined` 时不阻止执行。
   * @remarks 返回 `{ block: true }` 时阻止执行，循环改为发出错误工具结果。
   * 被阻止的结果也可设置 `terminate: true`，参与当前批次的提前终止判断。
   */
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;

  /**
   * 在工具执行结束后、工具执行结束事件及工具结果消息发出前覆盖执行结果。
   *
   * @param context - 工具调用、已校验参数、原执行结果和当前代理上下文。
   * @param signal - 可选的取消信号，回调应响应此信号。
   * @returns Promise 完成后的覆盖项；返回 `undefined` 时保留原执行结果。
   * @remarks 按字段替换 `content`、`details`、`structuredContent`、`isError`、`usage` 和 `terminate`，不进行深层合并。
   * 未提供的字段保留原值；仅替换 `content` 而未返回 `structuredContent` 时丢弃原结构化内容。
   */
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
}

/**
 * 模型的思考或推理级别，`"off"` 表示关闭推理。
 *
 * `"xhigh"` 和 `"max"` 仅受部分模型支持，应通过模型的推理级别元数据确认支持范围。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 通过声明合并扩展应用自定义消息的接口。
 *
 * 默认不包含自定义消息；扩展字段的值类型会加入 `AgentMessage` 联合类型。
 */
export interface CustomAgentMessages {
  // 默认留空，由应用通过声明合并扩展。
}

/**
 * 模型消息与应用自定义消息的联合类型。
 *
 * 允许应用添加自定义消息类型，同时保持与基础模型消息的兼容性。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * 代理对外公开的状态。
 *
 * `tools` 和 `messages` 使用访问器；实现应在保存赋入的数组前复制其顶层数组。
 */
export interface AgentState {
  /**
   * 从对话记录中的系统消息还原的当前系统提示词。
   *
   * 只读；修改提示词时应追加带有 `content` 或 `sections` 的系统消息。
   */
  readonly systemPrompt: string;
  /** 后续轮次使用的模型。 */
  model: Model<any>;
  /** 后续轮次请求的推理级别。 */
  thinkingLevel: ThinkingLevel;

  /**
   * 设置可执行工具；实现应复制赋入数组的顶层数组。
   *
   * @param tools - 新的可执行工具数组。
   * @remarks 与对话记录中工具声明的差异应在下一次请求前通过系统消息告知模型。
   */
  set tools(tools: AgentTool<any>[]);

  /**
   * 获取当前可执行工具。
   * @returns 当前工具数组。
   */
  get tools(): AgentTool<any>[];

  /**
   * 设置对话记录；实现应复制赋入数组的顶层数组。
   *
   * @param messages - 新的对话消息数组。
   * @remarks 系统消息承载提示词及工具声明。
   */
  set messages(messages: AgentMessage[]);

  /**
   * 获取当前对话记录。
   * @returns 当前对话消息数组。
   */
  get messages(): AgentMessage[];

  /** 代理处理提示消息或继续运行时为 true，直到 agent_end 的异步监听器完成。 */
  readonly isStreaming: boolean;
  /** 当前流式响应中的部分助手消息；尚无部分消息时为 `undefined`。 */
  readonly streamingMessage?: AgentMessage;
  /** 当前正在执行的工具调用标识集合。 */
  readonly pendingToolCalls: ReadonlySet<string>;
  /** 最近一次失败或取消的助手轮次的错误信息；没有错误信息时为 `undefined`。 */
  readonly errorMessage?: string;
}

/** 工具产生的最终结果或部分结果。 */
export interface AgentToolResult<T = JsonValue | undefined> {
  /** 返回给模型的文本或图片内容。 */
  content: (TextContent | ImageContent)[];
  /** 用于日志或界面展示的结构化详情。 */
  details: T;
  /**
   * 符合工具 `outputSchema` 的机器可读结果，供程序调用方使用。
   *
   * 不发送给模型；`content` 仍是面向模型的结果内容。
   */
  structuredContent?: JsonValue;
  /** 工具最终执行产生的用量；不计入模型主要对话上下文的用量。 */
  usage?: Usage;
  /**
   * 无需抛出异常即可报告执行失败。
   *
   * 模型将 `content` 作为错误结果处理；`details` 和 `structuredContent` 仍保留供界面和程序调用方使用。
   */
  isError?: boolean;
  /**
   * 请求在当前工具批次结束后提前终止。
   * 只有批次中所有最终工具结果的 `terminate` 都为 `true` 时，才会提前终止。
   */
  terminate?: boolean;
}

/** 工具调用在回调处理完成后的最终结果。 */
export interface AgentToolCallOutcome {
  toolCall: AgentToolCall;
  result: AgentToolResult<any>;
  isError: boolean;
}

/**
 * 在工具执行过程中推送部分执行结果。
 *
 * @param partialResult - 本次更新的部分执行结果。
 * @remarks 回调仅在当前 `execute()` 调用期间有效；工具执行的 Promise 完成或拒绝后，后续更新将被忽略。
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** 代理运行时使用的工具定义。 */
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = any,
> extends Tool<TParameters> {
  /** 用于界面展示的工具名称。 */
  label: string;
  /**
   * 在参数模式校验前转换原始工具调用参数。
   *
   * @param args - 原始工具调用参数。
   * @returns 符合 `TParameters` 参数模式的对象。
   * @throws 参数转换失败时可抛出异常。
   */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  /**
   * 成功结果中 `structuredContent` 的 JSON Schema。
   *
   * 声明此字段的工具应在成功结果中设置 `structuredContent`。
   */
  outputSchema?: TSchema;
  /**
   * 执行工具调用并返回最终执行结果。
   *
   * @param toolCallId - 本次工具调用的标识。
   * @param params - 符合工具参数模式的参数。
   * @param signal - 可选的取消信号。
   * @param onUpdate - 可选的部分结果回调。
   * @returns Promise 完成后的工具执行结果。
   * @throws 执行失败时可拒绝 Promise；也可返回 `isError: true` 的结果报告失败。
   * @remarks 不应仅在 `content` 中描述失败而不设置错误标记。
   */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /** 操作意图已持久化但结果未知时的重放恢复策略。 */
  replay?: "never" | "safe";
  /**
   * 覆盖单个工具的执行方式。
   *
   * - `"sequential"`：该工具必须与其他调用依次执行。
   * - `"parallel"`：该工具可与其他调用并发执行。
   *
   * 省略时使用默认执行方式。
   */
  executionMode?: ToolExecutionMode;
}

/** 传入底层代理循环的上下文快照。 */
export interface AgentContext {
  /** 模型可见的对话记录。 */
  messages: AgentMessage[];
  /** 本次运行中可执行的工具。 */
  tools?: AgentTool<any>[];
}

/**
 * 代理循环发出的生命周期事件，供界面更新使用。
 *
 * `agent_end` 是本次运行发出的最后一个事件。
 */
export type AgentEvent =
  // 代理生命周期。
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // 轮次生命周期；一轮包含一次助手响应及其工具调用和结果。
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // 消息生命周期；用于系统消息、用户消息、助手消息和工具结果消息。
  | { type: "message_start"; message: AgentMessage }
  // 仅在助手消息流式生成期间发出。
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // 工具执行生命周期。
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: any;
      partialResult: any;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: any;
      isError: boolean;
    };

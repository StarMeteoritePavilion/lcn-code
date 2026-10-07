import {
  createInitialSystemMessage,
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingBudgets,
  toToolDeclaration,
} from "../llm-api/index.ts";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentState,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  FinishTurn,
  PrepareNextTurnContext,
  PrepareRequest,
  QueueMode,
  StreamFn,
  ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message: AgentMessage): boolean =>
      message.role === "system" ||
      message.role === "user" ||
      message.role === "assistant" ||
      message.role === "toolResult",
  );
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL = {
  id: "unknown",
  name: "unknown",
  api: "unknown",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
} satisfies Model<any>;

type MutableAgentState = Omit<
  AgentState,
  "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"
> & {
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
};

/** 初始代理状态，提示词与工具在没有首条系统消息时写入对话。 */
export type AgentInitialState = Partial<
  Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
>;

function createMutableAgentState(initialState?: AgentInitialState): MutableAgentState {
  let tools = initialState?.tools?.slice() ?? [];
  let messages = initialState?.messages?.slice() ?? [];
  const initialMessage = createInitialSystemMessage(
    initialState?.systemPrompt,
    tools.map(toToolDeclaration),
  );
  if (messages[0]?.role !== "system" && initialMessage) {
    messages.unshift(initialMessage);
  }

  return {
    /**
     * 重放系统消息并读取当前提示词。
     * @returns 当前系统提示词。
     */
    get systemPrompt(): string {
      return getCurrentSystemPrompt(messages);
    },
    model: initialState?.model ?? DEFAULT_MODEL,
    thinkingLevel: initialState?.thinkingLevel ?? "off",
    /**
     * 读取当前可执行工具数组。
     * @returns 当前工具数组。
     */
    get tools(): AgentTool<any>[] {
      return tools;
    },
    /**
     * 复制并保存新的可执行工具数组。
     * @param nextTools - 新的数组。
     */
    set tools(nextTools: AgentTool<any>[]) {
      tools = nextTools.slice();
    },
    /**
     * 读取当前对话消息数组。
     * @returns 当前消息数组。
     */
    get messages(): AgentMessage[] {
      return messages;
    },
    /**
     * 复制并保存新的对话消息数组。
     * @param nextMessages - 新的数组。
     */
    set messages(nextMessages: AgentMessage[]) {
      messages = nextMessages.slice();
    },
    isStreaming: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined,
  };
}

/** 代理构造选项，模型调用使用当前项目的静态密钥。 */
export interface AgentOptions {
  initialState?: AgentInitialState;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  streamFn: StreamFn;
  apiKey: string;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  finishTurn?: FinishTurn;
  prepareRequest?: PrepareRequest;
  prepareNextTurn?: (
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  prepareNextTurnWithContext?: (
    context: PrepareNextTurnContext,
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  sessionId?: string;
  thinkingBudgets?: ThinkingBudgets;
  maxRetryDelayMs?: number;
  toolExecution?: ToolExecutionMode;
}

class PendingMessageQueue {
  private messages: AgentMessage[] = [];
  public mode: QueueMode;

  constructor(mode: QueueMode) {
    this.mode = mode;
  }

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  hasItems(): boolean {
    return this.messages.length > 0;
  }

  peek(): AgentMessage[] {
    if (this.mode === "all") {
      return this.messages.slice();
    }
    const first = this.messages[0];
    return first ? [first] : [];
  }

  drain(): AgentMessage[] {
    const drained = this.peek();
    this.messages = this.messages.slice(drained.length);
    return drained;
  }

  clear(): void {
    this.messages = [];
  }
}

type ActiveRun = {
  promise: Promise<void>;
  resolve: () => void;
  abortController: AbortController;
  hasListenerFailed: boolean;
};

/** 管理对话状态、排队消息、取消及异步事件监听器的代理。 */
export class Agent {
  private currentState: MutableAgentState;
  private readonly listeners = new Set<
    (event: AgentEvent, signal: AbortSignal) => Promise<void> | void
  >();
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;

  public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  public transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentMessage[]>;
  public streamFunction: StreamFn;
  public apiKey: string;
  public onPayload?: SimpleStreamOptions["onPayload"];
  public onResponse?: SimpleStreamOptions["onResponse"];
  public onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
  public beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  public afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  public finishTurn?: FinishTurn;
  public prepareRequest?: PrepareRequest;
  public prepareNextTurn?: (
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  public prepareNextTurnWithContext?: (
    context: PrepareNextTurnContext,
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  private activeRun?: ActiveRun;

  public sessionId?: string;

  public thinkingBudgets?: ThinkingBudgets;

  public maxRetryDelayMs?: number;

  public toolExecution: ToolExecutionMode;

  /**
   * 创建代理并复制初始状态。
   * @param options - 初始状态、静态密钥和流式请求函数。
   * @throws 未提供流函数且默认函数未配置时抛出错误。
   */
  constructor(options: AgentOptions) {
    const runtimeOptions: Partial<AgentOptions> = options ?? {};
    this.currentState = createMutableAgentState(runtimeOptions.initialState);
    this.convertToLlm = runtimeOptions.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = runtimeOptions.transformContext;
    this.streamFunction = runtimeOptions.streamFn ?? getDefaultStreamFn();
    this.apiKey = options.apiKey;
    this.onPayload = runtimeOptions.onPayload;
    this.onResponse = runtimeOptions.onResponse;
    this.onProviderStreamEvent = runtimeOptions.onProviderStreamEvent;
    this.beforeToolCall = runtimeOptions.beforeToolCall;
    this.afterToolCall = runtimeOptions.afterToolCall;
    this.finishTurn = runtimeOptions.finishTurn;
    this.prepareRequest = runtimeOptions.prepareRequest;
    this.prepareNextTurn = runtimeOptions.prepareNextTurn;
    this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
    this.steeringQueue = new PendingMessageQueue(runtimeOptions.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(runtimeOptions.followUpMode ?? "one-at-a-time");
    this.sessionId = runtimeOptions.sessionId;
    this.thinkingBudgets = runtimeOptions.thinkingBudgets;
    this.maxRetryDelayMs = runtimeOptions.maxRetryDelayMs;
    this.toolExecution = runtimeOptions.toolExecution ?? "parallel";
  }

  /**
   * 订阅生命周期事件，按注册顺序等待监听器完成。
   * @param listener - 接收事件与当前取消信号的监听器。
   * @returns 取消订阅的函数。
   * @remarks 监听器异常原样拒绝当前 prompt 或 continue，并停止本次事件分发。
   */
  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 读取当前代理状态，数组赋值时复制顶层数组。
   * @returns 当前状态。
   */
  get state(): AgentState {
    return this.currentState;
  }

  /**
   * 设置队列取出模式。
   * @param mode - 新的取出模式。
   */
  set steeringMode(mode: QueueMode) {
    this.steeringQueue.mode = mode;
  }

  /**
   * 读取引导队列的取出模式。
   * @returns 当前队列模式。
   */
  get steeringMode(): QueueMode {
    return this.steeringQueue.mode;
  }

  /**
   * 设置队列取出模式。
   * @param mode - 新的取出模式。
   */
  set followUpMode(mode: QueueMode) {
    this.followUpQueue.mode = mode;
  }

  /**
   * 读取后续队列的取出模式。
   * @returns 当前队列模式。
   */
  get followUpMode(): QueueMode {
    return this.followUpQueue.mode;
  }

  /**
   * 将消息加入引导队列，在当前工具批次完成后处理。
   * @param message - 待处理消息。
   */
  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  /**
   * 将消息加入后续队列，在自然停止时处理。
   * @param message - 待处理消息。
   */
  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  /**
   * 清空引导队列。
   */
  clearSteeringQueue(): void {
    this.steeringQueue.clear();
  }

  /**
   * 清空后续队列。
   */
  clearFollowUpQueue(): void {
    this.followUpQueue.clear();
  }

  /**
   * 清空两个消息队列。
   */
  clearAllQueues(): void {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  /**
   * 检查是否存在排队消息。
   * @returns 任一队列非空时返回 true。
   */
  hasQueuedMessages(): boolean {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }

  /**
   * 预览下一批排队消息，不消耗队列。
   * @returns 优先取引导消息，再取后续消息；没有消息时返回空数组。
   */
  peekQueuedMessages(): AgentMessage[] {
    const steering = this.steeringQueue.peek();
    return steering.length > 0 ? steering : this.followUpQueue.peek();
  }

  /**
   * 读取当前运行的取消信号。
   * @returns 运行信号；空闲时为 undefined。
   */
  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  /**
   * 取消当前运行。
   */
  abort(): void {
    this.activeRun?.abortController.abort();
  }

  /**
   * 等待当前运行及其异步监听器完成。
   * @returns Promise 完成表示代理已空闲，不表示运行成功；运行异常由 prompt 或 continue 报告。
   */
  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  /**
   * 清空对话与队列，保留重放后的系统提示和工具声明。
   * @throws 正在运行时抛出错误。
   */
  reset(): void {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Wait for completion before resetting.");
    }

    const baseline = getCurrentSystemMessage(this.currentState.messages);
    this.currentState.messages = baseline ? [baseline] : [];
    this.currentState.isStreaming = false;
    this.currentState.streamingMessage = undefined;
    this.currentState.pendingToolCalls = new Set<string>();
    this.currentState.errorMessage = undefined;
    this.clearFollowUpQueue();
    this.clearSteeringQueue();
  }

  /**
   * 从消息或消息数组开始运行。
   * @param message - 待追加消息。
   * @returns 运行和监听器完成后结束，模型或循环失败记录在 state.errorMessage。
   * @throws 已有运行或监听器失败时拒绝。
   * @remarks 完成不代表模型成功；监听器失败不会追加错误助手消息。
   */
  async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  /**
   * 从文本及可选图片开始运行。
   * @param input - 用户文本。
   * @param images - 可选图片。
   * @returns 运行和监听器完成后结束，模型或循环失败记录在 state.errorMessage。
   * @throws 已有运行或监听器失败时拒绝。
   * @remarks 完成不代表模型成功；监听器失败不会追加错误助手消息。
   */
  async prompt(input: string, images?: ImageContent[]): Promise<void>;
  /**
   * 规范化输入并启动运行。
   * @param input - 文本、消息或消息数组。
   * @param images - 文本输入的可选图片。
   * @returns 运行和监听器完成后结束，模型或循环失败记录在 state.errorMessage。
   * @throws 已有运行或监听器失败时拒绝。
   * @remarks 完成不代表模型成功；监听器失败不会追加错误助手消息。
   */
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<void> {
    if (this.activeRun) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    }
    const messages = this.normalizePromptInput(input, images);
    await this.runPromptMessages(messages);
  }

  /**
   * 继续已有对话，助手末尾时优先使用排队消息。
   * @returns Promise 完成表示运行和监听器已结束。
   * @throws 正在运行、上下文不能继续或监听器失败时拒绝。
   * @remarks 模型或循环失败记录在 state.errorMessage；监听器失败直接传播。
   */
  async continue(): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }

    const lastMessage = this.currentState.messages[this.currentState.messages.length - 1];
    if (
      !lastMessage ||
      this.currentState.messages.every(
        (message: AgentMessage): boolean => message.role === "system",
      )
    ) {
      throw new Error("No messages to continue from");
    }

    if (lastMessage.role === "assistant") {
      const queuedSteering = this.steeringQueue.drain();
      if (queuedSteering.length > 0) {
        await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
        return;
      }

      const queuedFollowUps = this.followUpQueue.drain();
      if (queuedFollowUps.length > 0) {
        await this.runPromptMessages(queuedFollowUps);
        return;
      }

      throw new Error("Cannot continue from message role: assistant");
    }

    await this.runContinuation();
  }

  private normalizePromptInput(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): AgentMessage[] {
    if (Array.isArray(input)) {
      return input;
    }

    if (typeof input !== "string") {
      return [input];
    }

    const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
    if (images && images.length > 0) {
      content.push(...images);
    }
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  private async runPromptMessages(
    messages: AgentMessage[],
    options: { skipInitialSteeringPoll?: boolean } = {},
  ): Promise<void> {
    await this.runWithLifecycle(async (signal: AbortSignal): Promise<void> => {
      await runAgentLoop(
        messages,
        this.createContextSnapshot(),
        this.createLoopConfig(options),
        (event: AgentEvent): Promise<void> => this.processEvents(event),
        signal,
        this.streamFunction,
      );
    });
  }

  private async runContinuation(): Promise<void> {
    await this.runWithLifecycle(async (signal: AbortSignal): Promise<void> => {
      await runAgentLoopContinue(
        this.createContextSnapshot(),
        this.createLoopConfig(),
        (event: AgentEvent): Promise<void> => this.processEvents(event),
        signal,
        this.streamFunction,
      );
    });
  }

  private createContextSnapshot(): AgentContext {
    return {
      messages: this.currentState.messages.slice(),
      tools: this.currentState.tools.slice(),
    };
  }

  private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
    let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
    return {
      model: this.currentState.model,
      apiKey: this.apiKey,
      reasoning:
        this.currentState.thinkingLevel === "off" ? undefined : this.currentState.thinkingLevel,
      sessionId: this.sessionId,
      onPayload: this.onPayload,
      onResponse: this.onResponse,
      onProviderStreamEvent: this.onProviderStreamEvent,
      thinkingBudgets: this.thinkingBudgets,
      maxRetryDelayMs: this.maxRetryDelayMs,
      toolExecution: this.toolExecution,
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
      finishTurn: this.finishTurn,
      prepareRequest: this.prepareRequest,
      /**
       * 为下一轮调用宿主准备钩子。
       * @param context - 上一轮完成后的上下文。
       * @returns 替换状态；undefined 表示保留。
       */
      prepareNextTurn:
        this.prepareNextTurnWithContext || this.prepareNextTurn
          ? async (context: PrepareNextTurnContext): Promise<AgentLoopTurnUpdate | undefined> => {
              if (this.prepareNextTurnWithContext) {
                return await this.prepareNextTurnWithContext(context, this.signal);
              }
              return await this.prepareNextTurn?.(this.signal);
            }
          : undefined,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      /**
       * 读取下一批引导消息。
       * @returns 本轮消息，或空数组。
       */
      getSteeringMessages: async (): Promise<AgentMessage[]> => {
        if (skipInitialSteeringPoll) {
          skipInitialSteeringPoll = false;
          return [];
        }
        return this.steeringQueue.drain();
      },
      /**
       * 读取下一批后续消息。
       * @returns 本轮消息，或空数组。
       */
      getFollowUpMessages: async (): Promise<AgentMessage[]> => this.followUpQueue.drain(),
    };
  }

  /**
   * 管理单次运行的状态，将循环失败记录为助手消息并在最终释放空闲等待者。
   * @param executor - 使用本次取消信号执行循环的函数。
   * @returns 执行及监听器完成并清理运行状态后兑现；循环失败已记录到消息与状态。
   * @throws 已有运行或监听器抛错、拒绝时原样拒绝。
   * @remarks 监听器异常直接传播，不追加失败消息或重新发送生命周期事件。
   */
  private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing.");
    }

    const abortController = new AbortController();
    /** 保存当前运行的完成通知函数。 */
    let resolvePromise = (): void => {};
    const promise = new Promise<void>((resolve: () => void): void => {
      resolvePromise = resolve;
    });
    this.activeRun = {
      promise,
      resolve: resolvePromise,
      abortController,
      hasListenerFailed: false,
    };

    this.currentState.isStreaming = true;
    this.currentState.streamingMessage = undefined;
    this.currentState.errorMessage = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      if (this.activeRun.hasListenerFailed) {
        throw error;
      }
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.finishRun();
    }
  }

  /**
   * 为循环异常追加失败助手消息并依次通知结束事件。
   * @param error - 循环抛出的值。
   * @param isAborted - 本次运行是否已取消。
   * @returns 失败消息写入状态且结束事件监听器完成后兑现。
   * @throws 监听器失败时原样拒绝。
   */
  private async handleRunFailure(error: unknown, isAborted: boolean): Promise<void> {
    const failureMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: this.currentState.model.api,
      baseUrl: this.currentState.model.baseUrl,
      model: this.currentState.model.id,
      usage: EMPTY_USAGE,
      stopReason: isAborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    } satisfies AgentMessage;
    await this.processEvents({ type: "message_start", message: failureMessage });
    await this.processEvents({ type: "message_end", message: failureMessage });
    await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
    await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  }

  private finishRun(): void {
    this.currentState.isStreaming = false;
    this.currentState.streamingMessage = undefined;
    this.currentState.pendingToolCalls = new Set<string>();
    this.activeRun?.resolve();
    this.activeRun = undefined;
  }

  /**
   * 先归并事件状态，再按订阅顺序等待监听器完成。
   * @param event - 当前循环事件。
   * @returns 状态更新和全部监听器执行完成。
   * @remarks agent_end 监听器完成前仍保持运行状态，由 finishRun 清理。
   * @throws 没有活动运行或监听器拒绝时向调用方传播异常。
   */
  private async processEvents(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
        this.currentState.streamingMessage = event.message;
        break;

      case "message_update":
        this.currentState.streamingMessage = event.message;
        break;

      case "message_end":
        this.currentState.streamingMessage = undefined;
        this.currentState.messages.push(event.message);
        break;

      case "tool_execution_start": {
        const pendingToolCalls = new Set(this.currentState.pendingToolCalls);
        pendingToolCalls.add(event.toolCallId);
        this.currentState.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "tool_execution_end": {
        const pendingToolCalls = new Set(this.currentState.pendingToolCalls);
        pendingToolCalls.delete(event.toolCallId);
        this.currentState.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this.currentState.errorMessage = event.message.errorMessage;
        }
        break;

      case "agent_end":
        this.currentState.streamingMessage = undefined;
        break;
    }

    const activeRun = this.activeRun;
    if (!activeRun) {
      throw new Error("Agent listener invoked outside active run");
    }
    const signal = activeRun.abortController.signal;
    for (const listener of this.listeners) {
      try {
        await listener(event, signal);
      } catch (error) {
        activeRun.hasListenerFailed = true;
        throw error;
      }
    }
  }
}

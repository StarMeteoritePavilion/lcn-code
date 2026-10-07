import {
  type AssistantMessage,
  EventStream,
  getCurrentTools,
  getToolStateChanges,
  normalizeContext,
  type SystemMessage,
  type ToolResultMessage,
  type ToolStateChanges,
  toToolDeclaration,
  validateToolArguments,
} from "../llm-api/index.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolCallOutcome,
  AgentToolResult,
  PrepareNextTurnContext,
  StreamFn,
} from "./types.ts";

type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * 从提示消息启动代理循环并返回生命周期事件流。
 * @param prompts - 本次运行追加的提示消息。
 * @param context - 已有对话记录和可执行工具。
 * @param config - 模型、请求选项和循环回调配置。
 * @param signal - 取消信号；undefined 表示不指定信号。
 * @param streamFn - 本次运行使用的流式请求函数。
 * @returns 事件流的最终结果为本次运行新增的消息，包含提示消息和补充的工具声明。
 * @remarks 使用独立的消息数组运行，保留已有消息对象的引用。回调异常会拒绝后台任务，事件流不会将其转换为错误事件。
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();

  void runAgentLoop(
    prompts,
    context,
    config,
    async (event: AgentEvent): Promise<void> => {
      stream.push(event);
    },
    signal,
    streamFn,
  ).then((messages: AgentMessage[]): void => {
    stream.end(messages);
  });

  return stream;
}

/**
 * 从现有上下文继续代理循环，不追加新的提示消息。
 *
 * @param context - 包含已有消息和可执行工具的上下文。
 * @param config - 模型、请求选项和循环回调配置。
 * @param signal - 取消本次运行的信号；传入 `undefined` 时不指定信号。
 * @param streamFn - 本次运行使用的流式请求函数。
 * @returns 代理事件流，最终结果为本次运行新增的消息。
 * @throws 上下文末尾没有消息或最后一条消息为助手消息时抛出错误。
 * @remarks 此入口仅拒绝空上下文及原始消息末尾的助手消息，不验证转换后的角色。
 * 运行时共享并修改 context.messages；回调异常会拒绝后台任务，事件流不会将其转换为错误事件。
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const lastMessage = context.messages.at(-1);
  if (!lastMessage) {
    throw new Error("Cannot continue: no messages in context");
  }

  if (lastMessage.role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const stream = createAgentStream();

  void runAgentLoopContinue(
    context,
    config,
    async (event: AgentEvent): Promise<void> => {
      stream.push(event);
    },
    signal,
    streamFn,
  ).then((messages: AgentMessage[]): void => {
    stream.end(messages);
  });

  return stream;
}

/**
 * 从提示消息启动代理循环，通过回调发出事件并返回新增消息。
 * @param prompts - 本次运行追加的提示消息。
 * @param context - 已有对话记录和可执行工具。
 * @param config - 模型、请求选项和循环回调配置。
 * @param emit - 接收事件的回调；返回 Promise 时等待其完成。
 * @param signal - 取消信号；undefined 表示不指定信号。
 * @param streamFn - 本次运行使用的流式请求函数。
 * @returns Promise 完成后得到新增消息，包含提示消息、工具声明、助手响应和工具结果。
 * @throws 事件回调、消息转换、模型请求或其他循环回调抛出异常或拒绝 Promise 时，拒绝运行。
 * @remarks 使用独立的消息数组运行，保留已有消息对象的引用；未提供流式函数时尝试读取默认函数。
 */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  const initialMessages = declareToolChanges(context, prompts);
  const newMessages: AgentMessage[] = [...initialMessages];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...initialMessages],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const message of initialMessages) {
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
  }

  await runLoop(
    currentContext,
    newMessages,
    config,
    signal,
    emit,
    streamFn ?? getDefaultStreamFn(),
  );
  return newMessages;
}

/**
 * 从现有上下文继续代理循环，通过回调发出事件并返回新增消息。
 *
 * @param context - 包含已有消息和可执行工具的上下文。
 * @param config - 模型、请求选项和循环回调配置。
 * @param emit - 接收代理事件的回调；返回 Promise 时等待其完成。
 * @param signal - 取消本次运行的信号；传入 `undefined` 时不指定信号。
 * @param streamFn - 本次运行使用的流式请求函数。
 * @returns Promise 完成后得到本次运行新增的消息，不包含上下文中已有的消息。
 * @throws 上下文末尾没有消息或最后一条消息为助手消息时拒绝 Promise。
 * 事件回调、消息转换或其他循环回调抛出异常或拒绝 Promise 时，运行也会拒绝 Promise。
 * @remarks 此入口仅拒绝空上下文及原始消息末尾的助手消息，不验证转换后的角色；
 * 运行期间会修改上下文共享的消息数组。
 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  const lastMessage = context.messages.at(-1);
  if (!lastMessage) {
    throw new Error("Cannot continue: no messages in context");
  }

  if (lastMessage.role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const newMessages: AgentMessage[] = [];
  const currentContext: AgentContext = { ...context };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(
    currentContext,
    newMessages,
    config,
    signal,
    emit,
    streamFn ?? getDefaultStreamFn(),
  );
  return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event: AgentEvent): boolean => event.type === "agent_end",
    (event: AgentEvent): AgentMessage[] => (event.type === "agent_end" ? event.messages : []),
  );
}

/**
 * 调度助手轮次、工具调用和排队消息，直到结束或收到终止决定。
 * @param initialContext - 运行开始时的上下文。
 * @param newMessages - 本次运行新增的消息数组，会持续追加。
 * @param initialConfig - 初始模型和循环回调配置。
 * @param signal - 可选的取消信号。
 * @param emit - 接收生命周期事件的回调。
 * @param streamFunction - 生成助手响应的流式请求函数。
 * @returns Promise 完成表示已发出 agent_end 并结束调度。
 * @throws 事件、消息转换、请求或调度回调抛出异常或拒绝 Promise 时向调用方传播。
 * @remarks 工具批次执行完成后读取引导消息；没有工具调用或引导消息时读取后续消息。
 */
async function runLoop(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFunction: StreamFn,
): Promise<void> {
  let currentContext = initialContext;
  let config = initialConfig;
  let lastCompletedTurn: PrepareNextTurnContext | undefined;
  let shouldContinueExplicitly = false;

  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      let preparedMessages: AgentMessage[] = [];
      if (lastCompletedTurn) {
        const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
        if (nextTurnSnapshot) {
          currentContext = nextTurnSnapshot.context ?? currentContext;
          preparedMessages = nextTurnSnapshot.messages ?? [];
          config = {
            ...config,
            model: nextTurnSnapshot.model ?? config.model,
            reasoning:
              nextTurnSnapshot.thinkingLevel === undefined
                ? config.reasoning
                : nextTurnSnapshot.thinkingLevel === "off"
                  ? undefined
                  : nextTurnSnapshot.thinkingLevel,
          };
        }
        // 准备期间可能新增引导消息；仅在之前没有取到消息时再次读取，
        // 避免逐条处理模式在同一轮取出两条消息。
        if (pendingMessages.length === 0) {
          pendingMessages = (await config.getSteeringMessages?.()) || [];
        }
        await emit({ type: "turn_start" });
      }

      for (const message of declareToolChanges(currentContext, [
        ...preparedMessages,
        ...pendingMessages,
      ])) {
        await emit({ type: "message_start", message });
        await emit({ type: "message_end", message });
        currentContext.messages.push(message);
        newMessages.push(message);
      }
      pendingMessages = [];

      const requestUpdate = await config.prepareRequest?.(
        {
          context: currentContext,
          model: config.model,
          thinkingLevel: config.reasoning ?? "off",
        },
        signal,
      );
      if (requestUpdate) {
        currentContext = requestUpdate.context ?? currentContext;
        config = {
          ...config,
          model: requestUpdate.model ?? config.model,
          reasoning:
            requestUpdate.thinkingLevel === undefined
              ? config.reasoning
              : requestUpdate.thinkingLevel === "off"
                ? undefined
                : requestUpdate.thinkingLevel,
        };
      }

      const message = await streamAssistantResponse(
        currentContext,
        config,
        signal,
        emit,
        streamFunction,
      );
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        lastCompletedTurn = {
          message,
          toolResults: [],
          context: currentContext,
          newMessages,
        };
        await config.finishTurn?.(lastCompletedTurn, signal);
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      const toolCalls = message.content.filter(
        (content: AssistantMessage["content"][number]): content is AgentToolCall =>
          content.type === "toolCall",
      );

      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;
      if (toolCalls.length > 0) {
        // 输出达到 token 上限时，全部工具参数均可能不完整，不执行这些调用。
        const executedToolBatch =
          message.stopReason === "length"
            ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
            : await executeToolCalls(currentContext, message, config, signal, emit);
        toolResults.push(...executedToolBatch.messages);
        hasMoreToolCalls = !executedToolBatch.shouldTerminate;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      lastCompletedTurn = {
        message,
        toolResults,
        context: currentContext,
        newMessages,
      };
      const decision = await config.finishTurn?.(lastCompletedTurn, signal);
      await emit({ type: "turn_end", message, toolResults });

      if (decision?.action === "end") {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      shouldContinueExplicitly = decision?.action === "continue";
      pendingMessages = (await config.getSteeringMessages?.()) || [];
      if (hasMoreToolCalls || pendingMessages.length > 0) {
        shouldContinueExplicitly = false;
      }
    }

    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      shouldContinueExplicitly = false;
      pendingMessages = followUpMessages;
      continue;
    }

    // 没有工具调用或排队消息时，用当前上下文满足继续一轮的决定。
    if (shouldContinueExplicitly) {
      shouldContinueExplicitly = false;
      continue;
    }

    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * 根据可执行工具与对话记录的差异，补充或更新待发送系统消息中的工具声明。
 *
 * @param context - 已提交的对话记录和当前可执行工具。
 * @param pendingMessages - 本轮准备追加的消息。
 * @returns 包含工具变更声明的待追加消息；无需变更时保留原消息数组。
 * @remarks 存在待发送系统消息时，以已提交记录和可执行工具计算的差异替换其工具字段。
 * 否则在第一条非系统消息之前插入新的系统消息；原上下文和消息对象不被修改。
 */
function declareToolChanges(
  context: AgentContext,
  pendingMessages: AgentMessage[],
): AgentMessage[] {
  let systemIndex = -1;
  for (let i = pendingMessages.length - 1; i >= 0; i--) {
    if (pendingMessages[i]?.role === "system") {
      systemIndex = i;
      break;
    }
  }
  const pending = pendingMessages[systemIndex] as SystemMessage | undefined;
  const baseline = pending
    ? pendingMessages.map((message: AgentMessage, index: number): AgentMessage =>
        index === systemIndex ? withToolChanges(pending, NO_CHANGES) : message,
      )
    : pendingMessages;
  const changes = getToolStateChanges(
    getCurrentTools([...context.messages, ...baseline]),
    (context.tools ?? []).map(toToolDeclaration),
  );
  const hasNoToolChanges = changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;

  if (pending) {
    // 无工具变更且原消息未声明变更时，保留调用方的消息对象。
    if (hasNoToolChanges && !pending.toolsAdded?.length && !pending.toolsRemoved?.length) {
      return pendingMessages;
    }
    return baseline.map((message: AgentMessage, index: number): AgentMessage =>
      index === systemIndex ? withToolChanges(pending, changes) : message,
    );
  }
  if (hasNoToolChanges) {
    return pendingMessages;
  }
  const update = withToolChanges({ role: "system", content: "", timestamp: Date.now() }, changes);
  const insertIndex = pendingMessages.findIndex(
    (message: AgentMessage): boolean => message.role !== "system",
  );
  const index = insertIndex === -1 ? pendingMessages.length : insertIndex;
  return [...pendingMessages.slice(0, index), update, ...pendingMessages.slice(index)];
}

const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };

/**
 * 复制系统消息并替换工具变更声明，省略空的新增或移除列表。
 * @param message - 原系统消息。
 * @param changes - 需要写入的工具变更。
 * @returns 新系统消息，其他字段保留原值。
 */
function withToolChanges(message: SystemMessage, changes: ToolStateChanges): SystemMessage {
  const { toolsAdded, toolsRemoved } = changes;
  const { toolsAdded: unusedToolsAdded, toolsRemoved: unusedToolsRemoved, ...rest } = message;
  return {
    ...rest,
    ...(toolsAdded.length > 0 ? { toolsAdded } : {}),
    ...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
  };
}

/**
 * 转换对话上下文并消费模型响应流，保存助手消息并发出消息事件。
 * @param context - 当前上下文，会追加或替换助手消息。
 * @param config - 消息转换、模型和请求配置。
 * @param signal - 可选的取消信号。
 * @param emit - 接收消息生命周期事件的回调。
 * @param streamFunction - 生成助手响应的流式请求函数。
 * @returns Promise 完成后的最终助手消息，包含本次请求的 thinkingLevel。
 * @throws 转换、流式请求、结果获取或事件回调抛出异常或拒绝 Promise 时向调用方传播。
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFunction: StreamFn,
): Promise<AssistantMessage> {
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  const llmMessages = await config.convertToLlm(messages);

  const llmContext = normalizeContext({ messages: llmMessages });

  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey: config.apiKey,
    signal,
  });

  /**
   * 获取最终响应并记录本次请求使用的推理级别。
   * @returns Promise 完成后的助手消息，会在原消息上写入 thinkingLevel。
   * @throws 响应流的结果 Promise 拒绝时向调用方传播异常。
   */
  const result = async (): Promise<AssistantMessage> => {
    const message = await response.result();
    return Object.assign(message, { thinkingLevel: config.reasoning ?? "off" });
  };

  let partialMessage: AssistantMessage | null = null;
  let hasPartialMessage = false;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        hasPartialMessage = true;
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;

      case "done":
      case "error": {
        const finalMessage = await result();
        if (hasPartialMessage) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }
        if (!hasPartialMessage) {
          await emit({ type: "message_start", message: { ...finalMessage } });
        }
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  const finalMessage = await result();
  if (hasPartialMessage) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: "message_start", message: { ...finalMessage } });
  }
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

/**
 * 将输出截断响应中的全部工具调用转换为错误结果，避免执行不完整参数。
 * @param toolCalls - 被截断的助手消息中的工具调用。
 * @param emit - 接收工具执行和结果消息事件的回调。
 * @returns Promise 完成后的错误工具结果批次，不请求提前终止。
 * @throws 事件回调抛出异常或拒绝 Promise 时向调用方传播。
 */
async function failToolCallsFromTruncatedMessage(
  toolCalls: AgentToolCall[],
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const messages: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    const finalized: FinalizedToolCallOutcome = {
      toolCall,
      result: createErrorToolResult(
        `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
      ),
      isError: true,
    };
    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    messages.push(toolResultMessage);
  }
  return { messages, shouldTerminate: false };
}

/**
 * 根据循环配置和单个工具的执行要求，选择顺序或并发执行工具批次。
 * @param currentContext - 当前对话记录和可执行工具。
 * @param assistantMessage - 发起工具调用的助手消息。
 * @param config - 工具执行模式和回调配置。
 * @param signal - 可选的取消信号。
 * @param emit - 接收工具和结果消息事件的回调。
 * @returns Promise 完成后的工具结果和批次终止标记。
 * @throws 事件或部分结果回调抛出异常或拒绝 Promise 时向调用方传播。
 * @remarks 任一目标工具要求 sequential 时，整个批次按顺序执行。
 */
async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const toolCalls = assistantMessage.content.filter(
    (content: AssistantMessage["content"][number]): content is AgentToolCall =>
      content.type === "toolCall",
  );
  const hasSequentialToolCall = toolCalls.some(
    (toolCall: AgentToolCall): boolean =>
      currentContext.tools?.find((tool: AgentTool<any>): boolean => tool.name === toolCall.name)
        ?.executionMode === "sequential",
  );
  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(
      currentContext,
      assistantMessage,
      toolCalls,
      config,
      signal,
      emit,
    );
  }
  return executeToolCallsParallel(
    currentContext,
    assistantMessage,
    toolCalls,
    config,
    signal,
    emit,
  );
}

type ExecutedToolCallBatch = {
  messages: ToolResultMessage[];
  shouldTerminate: boolean;
};

/**
 * 依次准备并执行工具调用，按调用顺序发出结果消息。
 * @param currentContext - 当前对话记录和可执行工具。
 * @param assistantMessage - 发起调用的助手消息。
 * @param toolCalls - 按执行顺序排列的工具调用。
 * @param config - 工具调用前后回调配置。
 * @param signal - 可选的取消信号。
 * @param emit - 接收执行和结果消息事件的回调。
 * @returns Promise 完成后的已处理工具结果及批次终止标记。
 * @throws 事件或部分结果回调抛出异常或拒绝 Promise 时向调用方传播。
 * @remarks 取消后停止处理后续调用。
 */
async function executeToolCallsSequential(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
    );
    let finalized: FinalizedToolCallOutcome;
    if (preparation.kind === "immediate") {
      finalized = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
      };
    } else {
      const executed = await executePreparedToolCall(
        preparation,
        signal,
        emitToolExecutionUpdate(toolCall, emit),
      );
      finalized = await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
      );
    }

    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    finalizedCalls.push(finalized);
    messages.push(toolResultMessage);

    if (signal?.aborted) {
      break;
    }
  }

  return {
    messages,
    shouldTerminate: shouldTerminateToolBatch(finalizedCalls),
  };
}

/**
 * 按顺序准备工具调用，并发执行获准调用并按原顺序汇总结果消息。
 * @param currentContext - 当前对话记录和可执行工具。
 * @param assistantMessage - 发起调用的助手消息。
 * @param toolCalls - 按原始顺序排列的工具调用。
 * @param config - 工具调用前后回调配置。
 * @param signal - 可选的取消信号。
 * @param emit - 接收执行和结果消息事件的回调。
 * @returns Promise 完成后的有序工具结果及批次终止标记。
 * @throws 事件或部分结果回调抛出异常或拒绝 Promise 时向调用方传播。
 * @remarks 工具执行结束事件按完成顺序发出；结果消息按原始调用顺序发出。
 */
async function executeToolCallsParallel(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallEntry[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
    );
    if (preparation.kind === "immediate") {
      const finalized = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
      } satisfies FinalizedToolCallOutcome;
      await emitToolExecutionEnd(finalized, emit);
      finalizedCalls.push(finalized);
      if (signal?.aborted) {
        break;
      }
      continue;
    }

    finalizedCalls.push(async (): Promise<FinalizedToolCallOutcome> => {
      if (signal?.aborted) {
        const finalized = {
          toolCall,
          result: createErrorToolResult("Operation aborted"),
          isError: true,
        } satisfies FinalizedToolCallOutcome;
        await emitToolExecutionEnd(finalized, emit);
        return finalized;
      }
      const executed = await executePreparedToolCall(
        preparation,
        signal,
        emitToolExecutionUpdate(toolCall, emit),
      );
      const finalized = await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
      );
      await emitToolExecutionEnd(finalized, emit);
      return finalized;
    });
    if (signal?.aborted) {
      break;
    }
  }

  const orderedFinalizedCalls = await Promise.all(
    finalizedCalls.map((entry: FinalizedToolCallEntry): Promise<FinalizedToolCallOutcome> =>
      typeof entry === "function" ? entry() : Promise.resolve(entry),
    ),
  );
  const messages: ToolResultMessage[] = [];
  for (const finalized of orderedFinalizedCalls) {
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    messages.push(toolResultMessage);
  }

  return {
    messages,
    shouldTerminate: shouldTerminateToolBatch(orderedFinalizedCalls),
  };
}

type PreparedToolCall = {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool<any>;
  args: unknown;
};

type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: AgentToolResult<any>;
  isError: boolean;
};

type ExecutedToolCallOutcome = {
  result: AgentToolResult<any>;
  isError: boolean;
};

type FinalizedToolCallOutcome = AgentToolCallOutcome;

type ToolCallHooks = Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall">;

type ToolUpdateSink = (partialResult: AgentToolResult<any>) => Promise<void> | void;

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

/**
 * 判断非空工具批次中的全部最终结果是否都请求提前终止。
 * @param finalizedCalls - 应用调用后回调后的工具结果。
 * @returns 批次非空且每项 terminate 都为 true 时返回 true。
 */
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
  return (
    finalizedCalls.length > 0 &&
    finalizedCalls.every(
      (finalized: FinalizedToolCallOutcome): boolean => finalized.result.terminate === true,
    )
  );
}

/**
 * 在模式校验前调用工具参数转换器，保留未变化的工具调用对象。
 * @param tool - 可选带有参数转换器的目标工具。
 * @param toolCall - 原始工具调用。
 * @returns 原工具调用，或参数被转换后的新调用对象。
 * @throws 参数转换器抛出的异常向调用方传播。
 */
function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
  if (!tool.prepareArguments) {
    return toolCall;
  }
  const preparedArguments = tool.prepareArguments(toolCall.arguments);
  if (preparedArguments === toolCall.arguments) {
    return toolCall;
  }
  return {
    ...toolCall,
    arguments: preparedArguments as Record<string, any>,
  };
}

/**
 * 查找工具、转换并校验参数，然后通过调用前回调判断是否允许执行。
 * @param currentContext - 传入回调的当前上下文。
 * @param assistantMessage - 发起工具调用的助手消息。
 * @param toolCall - 原始工具调用。
 * @param config - 调用前回调配置。
 * @param signal - 可选的取消信号。
 * @param tools - 查找工具的集合，默认取上下文中的工具或空数组。
 * @returns Promise 完成后的待执行调用，或未知工具、参数错误、阻止执行及取消产生的即时错误结果。
 */
async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: ToolCallHooks,
  signal: AbortSignal | undefined,
  tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const tool = tools.find((tool: AgentTool<any>): boolean => tool.name === toolCall.name);
  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true,
    };
  }

  try {
    const preparedToolCall = prepareToolCallArguments(tool, toolCall);
    const validatedArgs = validateToolArguments(tool, preparedToolCall);
    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        {
          assistantMessage,
          toolCall,
          args: validatedArgs,
          context: currentContext,
        },
        signal,
      );
      if (signal?.aborted) {
        return {
          kind: "immediate",
          result: createErrorToolResult("Operation aborted"),
          isError: true,
        };
      }
      if (beforeResult?.block) {
        const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
        if (beforeResult.terminate === true) {
          result.terminate = true;
        }
        return {
          kind: "immediate",
          result,
          isError: true,
        };
      }
    }
    if (signal?.aborted) {
      return {
        kind: "immediate",
        result: createErrorToolResult("Operation aborted"),
        isError: true,
      };
    }
    return {
      kind: "prepared",
      toolCall,
      tool,
      args: validatedArgs,
    };
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

/**
 * 创建将工具部分结果转发为执行更新事件的回调。
 * @param toolCall - 产生更新的工具调用。
 * @param emit - 接收代理事件的回调。
 * @returns 部分结果回调；返回事件回调的执行结果。
 */
function emitToolExecutionUpdate(toolCall: AgentToolCall, emit: AgentEventSink): ToolUpdateSink {
  return (partialResult: AgentToolResult<any>): Promise<void> | void =>
    emit({
      type: "tool_execution_update",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
      partialResult,
    });
}

/** 单次工具调用所需的工具集合、上下文和回调配置。 */
export interface RunToolCallOptions extends ToolCallHooks {
  /** 按名称查找目标工具的集合。 */
  tools: readonly AgentTool<any>[];
  /** 传入工具回调的发起调用的助手消息。 */
  assistantMessage: AssistantMessage;
  /** 传入工具回调的当前代理上下文。 */
  context: AgentContext;
  /** 取消本次工具调用的信号。 */
  signal?: AbortSignal;
  /** 接收工具部分结果的回调；返回 Promise 时等待其完成。 */
  onUpdate?: ToolUpdateSink;
}

/**
 * 执行单次工具调用，复用参数准备、校验及调用前后回调流程。
 * @param toolCall - 待执行的原始工具调用。
 * @param options - 工具集合、助手消息、上下文和回调配置。
 * @returns Promise 完成后的工具调用结果；未知工具、校验失败、阻止执行及工具异常以 isError 为 true 报告。
 * @throws 部分结果回调返回被拒绝的 Promise 时，拒绝运行。
 * @remarks 不追加上下文消息或发出代理事件；通过 onUpdate 转发工具部分结果。
 */
export async function runToolCall(
  toolCall: AgentToolCall,
  options: RunToolCallOptions,
): Promise<AgentToolCallOutcome> {
  const { assistantMessage, context, signal } = options;
  const preparation = await prepareToolCall(
    context,
    assistantMessage,
    toolCall,
    options,
    signal,
    options.tools,
  );
  if (preparation.kind === "immediate") {
    return { toolCall, result: preparation.result, isError: preparation.isError };
  }
  const executed = await executePreparedToolCall(
    preparation,
    signal,
    options.onUpdate ?? ((): void => {}),
  );
  return finalizeExecutedToolCall(
    context,
    assistantMessage,
    preparation,
    executed,
    options,
    signal,
  );
}

/**
 * 执行已准备的工具调用，等待有效的部分结果回调完成并汇总执行结果。
 * @param prepared - 已找到工具并校验参数的调用。
 * @param signal - 可选的取消信号。
 * @param onUpdate - 接收工具部分结果的回调。
 * @returns Promise 完成后的执行结果；工具抛出的异常转换为错误结果。
 * @throws 部分结果回调返回被拒绝的 Promise 时，拒绝运行。
 * @remarks 工具 execute 完成或拒绝后忽略后续更新。
 */
async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
  const updateEvents: Promise<void>[] = [];
  let canAcceptUpdates = true;

  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args as never,
      signal,
      (partialResult: AgentToolResult<any>): void => {
        if (!canAcceptUpdates) {
          return;
        }
        const update = onUpdate(partialResult);
        const updateEvent = Promise.resolve(update);
        updateEvents.push(updateEvent);
      },
    );
    canAcceptUpdates = false;
    await Promise.all(updateEvents);
    return { result, isError: result.isError === true };
  } catch (error) {
    canAcceptUpdates = false;
    await Promise.all(updateEvents);
    return {
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  } finally {
    canAcceptUpdates = false;
  }
}

/**
 * 通过调用后回调覆盖工具执行结果，生成最终调用结果。
 * @param currentContext - 传入回调的当前上下文。
 * @param assistantMessage - 发起调用的助手消息。
 * @param prepared - 已准备的工具调用及参数。
 * @param executed - 工具执行结果及错误标记。
 * @param config - 调用后回调配置。
 * @param signal - 可选的取消信号。
 * @returns Promise 完成后的最终结果；调用后回调异常转换为错误结果。
 * @remarks 仅替换 content 而未提供 structuredContent 时，移除原结构化内容。
 */
async function finalizeExecutedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  config: ToolCallHooks,
  signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
          result,
          isError,
          context: currentContext,
        },
        signal,
      );
      if (afterResult) {
        // 替换内容但未同步提供结构化内容时，删除旧结构化内容，避免两者不一致。
        const structuredContent =
          afterResult.structuredContent ??
          (afterResult.content ? undefined : result.structuredContent);
        result = {
          ...result,
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          usage: afterResult.usage ?? result.usage,
          terminate: afterResult.terminate ?? result.terminate,
        };
        if (structuredContent === undefined) {
          delete result.structuredContent;
        } else {
          result.structuredContent = structuredContent;
        }
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }
  }

  return {
    toolCall: prepared.toolCall,
    result,
    isError,
  };
}

function createErrorToolResult(message: string): AgentToolResult<any> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

async function emitToolExecutionEnd(
  finalized: FinalizedToolCallOutcome,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    // 无类型约束的工具可能未返回 content，统一为空数组以避免污染对话记录。
    content: finalized.result.content ?? [],
    details: finalized.result.details,
    usage: finalized.result.usage,
    isError: finalized.isError,
    timestamp: Date.now(),
  };
}

async function emitToolResultMessage(
  toolResultMessage: ToolResultMessage,
  emit: AgentEventSink,
): Promise<void> {
  await emit({ type: "message_start", message: toolResultMessage });
  await emit({ type: "message_end", message: toolResultMessage });
}

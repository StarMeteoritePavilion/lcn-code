import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { Agent } from "../../src/agent-loop/index.ts";
import type {
  AgentEvent,
  AgentMessage,
  AgentLoopTurnUpdate,
  AgentTool,
  BeforeToolCallContext,
  PrepareNextTurnContext,
  StreamFn,
} from "../../src/agent-loop/types.ts";
import { AssistantMessageEventStream } from "../../src/llm-api/utils/event-stream.ts";
import type {
  ImageContent,
  Model,
  TranscriptContext,
  SimpleStreamOptions,
} from "../../src/llm-api/types.ts";
import { assistant, model, tool } from "../llm-api/helpers.ts";

/**
 * 返回一次内存助手响应。
 * @returns 无网络请求的响应流。
 */
function response(): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "done", reason: "stop", message: assistant() });
  return stream;
}

/**
 * 创建独立的用户消息。
 * @param content - 用户文本。
 * @returns 用户消息。
 */
function user(content: string): AgentMessage {
  return { role: "user", content, timestamp: 1 };
}

describe("Agent", (): void => {
  for (const eventType of ["message_start", "agent_end"] as const) {
    for (const isAsync of [false, true]) {
      it(`${eventType} 监听器${isAsync ? "异步拒绝" : "同步抛错"}原样传播且正常释放运行状态`, async (): Promise<void> => {
        const agent = new Agent({ apiKey: "离线密钥", streamFn: response });
        const failure = { message: "监听器失败" };
        const events: string[] = [];
        const unsubscribe = agent.subscribe((event: AgentEvent): Promise<void> | void => {
          events.push(event.type);
          if (event.type !== eventType) {
            return;
          }
          if (isAsync) {
            return Promise.reject(failure);
          }
          throw failure;
        });
        const running = agent.prompt("首次请求");
        const idle = agent.waitForIdle();
        await rejects(running, (error: unknown): boolean => {
          strictEqual(error, failure);
          return true;
        });
        await idle;
        strictEqual(events.at(-1), eventType);
        const failureEventCount = events.filter((type: string): boolean => type === eventType);
        strictEqual(failureEventCount.length, 1);
        const assistants = agent.state.messages.filter(
          (message: AgentMessage): boolean => message.role === "assistant",
        );
        deepStrictEqual(
          assistants,
          eventType === "agent_end" ? [assistant({ thinkingLevel: "off" })] : [],
        );
        strictEqual(agent.state.errorMessage, undefined);
        strictEqual(agent.state.isStreaming, false);
        strictEqual(agent.state.streamingMessage, undefined);
        strictEqual(agent.state.pendingToolCalls.size, 0);
        strictEqual(agent.signal, undefined);
        unsubscribe();
        await agent.prompt("再次请求");
        strictEqual(agent.state.messages.at(-1)?.role, "assistant");
      });
    }
  }

  it("空闲等待立即完成，重置清空无系统消息的对话", async (): Promise<void> => {
    const agent = new Agent({ apiKey: "离线密钥", streamFn: response });
    await agent.waitForIdle();
    agent.state.messages = [user("消息")];
    agent.reset();
    deepStrictEqual(agent.state.messages, []);
    strictEqual(agent.signal, undefined);
  });

  it("队列模式访问器改变下一批消息且不丢失队列", (): void => {
    const agent = new Agent({ apiKey: "离线密钥", streamFn: response });
    strictEqual(agent.steeringMode, "one-at-a-time");
    strictEqual(agent.followUpMode, "one-at-a-time");
    const first = user("一");
    const second = user("二");
    agent.steer(first);
    agent.steer(second);
    agent.steeringMode = "all";
    strictEqual(agent.steeringMode, "all");
    deepStrictEqual(agent.peekQueuedMessages(), [first, second]);
    agent.clearSteeringQueue();
    agent.followUp(first);
    agent.followUp(second);
    agent.followUpMode = "all";
    strictEqual(agent.followUpMode, "all");
    deepStrictEqual(agent.peekQueuedMessages(), [first, second]);
    agent.followUpMode = "one-at-a-time";
    deepStrictEqual(agent.peekQueuedMessages(), [first]);
    agent.clearAllQueues();
    deepStrictEqual(agent.peekQueuedMessages(), []);
  });

  it("助手末尾仅有后续消息时续跑，没有队列时拒绝", async (): Promise<void> => {
    const agent = new Agent({
      apiKey: "离线密钥",
      streamFn: response,
      initialState: { messages: [user("初始"), assistant()] },
    });
    await rejects(agent.continue(), /Cannot continue from message role: assistant/);
    const followUp = user("后续");
    agent.followUp(followUp);
    deepStrictEqual(agent.peekQueuedMessages(), [followUp]);
    await agent.continue();
    deepStrictEqual(agent.state.messages, [
      user("初始"),
      assistant(),
      followUp,
      assistant({ thinkingLevel: "off" }),
    ]);
    strictEqual(agent.hasQueuedMessages(), false);
  });

  it("消息数组逐条追加，文本与图片保留完整内容", async (): Promise<void> => {
    const agent = new Agent({ apiKey: "离线密钥", streamFn: response });
    const messages = [user("一"), user("二")];
    await agent.prompt(messages);
    deepStrictEqual(agent.state.messages, [...messages, assistant({ thinkingLevel: "off" })]);
    const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    await agent.prompt("图片问题", [image]);
    const imageMessage = agent.state.messages.at(-2);
    strictEqual(imageMessage?.role, "user");
    deepStrictEqual(imageMessage?.content, [{ type: "text", text: "图片问题" }, image]);
  });

  for (const hasContext of [false, true]) {
    it(`${hasContext ? "上下文" : "无上下文"}准备钩子接收运行信号并只在续轮时执行`, async (): Promise<void> => {
      const agent = new Agent({ apiKey: "离线密钥", streamFn: response });
      const queued = user("续轮");
      const injected = user("准备消息");
      let contextCalls = 0;
      let simpleCalls = 0;
      /**
       * 检查无上下文准备钩子的信号并注入消息。
       * @param signal - 当前运行的取消信号。
       * @returns 下一轮待追加的消息。
       */
      agent.prepareNextTurn = (signal?: AbortSignal): AgentLoopTurnUpdate | undefined => {
        simpleCalls++;
        strictEqual(signal, agent.signal);
        return { messages: [injected] };
      };
      if (hasContext) {
        /**
         * 检查完整轮次上下文及信号并注入消息。
         * @param context - 已完成轮次的上下文。
         * @param signal - 当前运行的取消信号。
         * @returns 下一轮待追加的消息。
         */
        agent.prepareNextTurnWithContext = (
          context: PrepareNextTurnContext,
          signal?: AbortSignal,
        ): AgentLoopTurnUpdate | undefined => {
          contextCalls++;
          strictEqual(signal, agent.signal);
          strictEqual(context.message.role, "assistant");
          return { messages: [injected] };
        };
      }
      agent.followUp(queued);
      await agent.prompt("开始");
      strictEqual(simpleCalls, hasContext ? 0 : 1);
      strictEqual(contextCalls, hasContext ? 1 : 0);
      strictEqual(agent.state.messages.includes(injected), true);
      strictEqual(agent.state.messages.includes(queued), true);
    });
  }

  it("初始化及赋值复制数组，重置保留系统基线", (): void => {
    const messages = [user("旧消息")];
    const agent = new Agent({
      apiKey: "离线密钥",
      streamFn: response,
      initialState: { model: model(), systemPrompt: "系统指令", messages },
    });
    strictEqual(agent.state.systemPrompt, "系统指令");
    strictEqual(agent.state.messages === messages, false);
    agent.state.messages = messages;
    strictEqual(agent.state.messages === messages, false);
    agent.state.tools = [];
    agent.state.messages = [{ role: "system", content: "新指令", timestamp: 1 }, ...messages];
    agent.steer(user("引导"));
    agent.followUp(user("后续"));
    agent.reset();
    strictEqual(agent.state.messages.length, 1);
    strictEqual(agent.state.systemPrompt, "新指令");
    strictEqual(agent.hasQueuedMessages(), false);
  });

  it("等待 agent_end 订阅者，忙碌时拒绝提示、继续和重置", async (): Promise<void> => {
    let release = (): void => {};
    const barrier = new Promise<void>((resolve: () => void): void => {
      release = resolve;
    });
    let reached = (): void => {};
    const started = new Promise<void>((resolve: () => void): void => {
      reached = resolve;
    });
    const agent = new Agent({ apiKey: "离线密钥", streamFn: response });
    agent.subscribe(async (event: AgentEvent, signal: AbortSignal): Promise<void> => {
      strictEqual(signal, agent.signal);
      if (event.type === "agent_end") {
        reached();
        await barrier;
      }
    });
    const prompt = agent.prompt("你好");
    await started;
    let idle = false;
    const settled = agent.waitForIdle().then((): void => {
      idle = true;
    });
    try {
      strictEqual(agent.state.isStreaming, true);
      strictEqual(idle, false);
      throws((): void => agent.reset(), /already processing/);
      await rejects(agent.prompt("重复"), /already processing/);
      await rejects(agent.continue(), /already processing/);
    } finally {
      release();
    }
    await Promise.all([prompt, settled]);
    strictEqual(agent.state.isStreaming, false);
    strictEqual(idle, true);
    strictEqual(agent.signal, undefined);
  });

  for (const mode of ["all", "one-at-a-time"] as const) {
    it(`${mode} 队列预览不消耗且助手末尾续跑优先引导`, async (): Promise<void> => {
      let requests = 0;
      const agent = new Agent({
        apiKey: "离线密钥",
        steeringMode: mode,
        followUpMode: mode,
        streamFn: (): AssistantMessageEventStream => {
          requests++;
          return response();
        },
        initialState: { messages: [user("初始"), assistant()] },
      });
      const first = user("引导一");
      const second = user("引导二");
      agent.steer(first);
      agent.steer(second);
      agent.followUp(user("后续"));
      deepStrictEqual(agent.peekQueuedMessages(), mode === "all" ? [first, second] : [first]);
      deepStrictEqual(agent.peekQueuedMessages(), mode === "all" ? [first, second] : [first]);
      await agent.continue();
      strictEqual(requests, mode === "all" ? 2 : 3);
      strictEqual(agent.hasQueuedMessages(), false);
      agent.steer(first);
      agent.clearSteeringQueue();
      agent.followUp(second);
      agent.clearFollowUpQueue();
      agent.steer(first);
      agent.followUp(second);
      agent.clearAllQueues();
      strictEqual(agent.hasQueuedMessages(), false);
    });
  }

  it("空上下文继续失败而不消耗队列", async (): Promise<void> => {
    const agent = new Agent({ apiKey: "离线密钥", streamFn: response });
    const queued = user("排队");
    agent.steer(queued);
    await rejects(agent.continue(), /No messages/);
    deepStrictEqual(agent.peekQueuedMessages(), [queued]);
  });

  it("流函数抛错转换为完整失败事件与状态", async (): Promise<void> => {
    const agent = new Agent({
      apiKey: "离线密钥",
      streamFn: (): AssistantMessageEventStream => {
        throw new Error("请求失败");
      },
    });
    const events: string[] = [];
    const unsubscribe = agent.subscribe((event: AgentEvent): void => {
      events.push(event.type);
    });
    await agent.prompt("问题");
    strictEqual(agent.state.errorMessage, "请求失败");
    strictEqual(agent.state.isStreaming, false);
    deepStrictEqual(events.slice(-4), ["message_start", "message_end", "turn_end", "agent_end"]);
    unsubscribe();
    const count = events.length;
    await agent.prompt("再次请求");
    strictEqual(events.length, count);
  });

  it("取消信号传入请求，取消结果完成状态收尾", async (): Promise<void> => {
    /**
     * 提供响应取消信号的内存流。
     * @param _model - 当前模型。
     * @param _context - 当前上下文。
     * @param options - 请求选项。
     * @returns 取消后结束的响应流。
     */
    const streamFn: StreamFn = (
      _model: Model,
      _context: TranscriptContext,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream => {
      const stream = new AssistantMessageEventStream();
      options?.signal?.addEventListener(
        "abort",
        (): void => {
          const error = assistant({ stopReason: "aborted", errorMessage: "已取消" });
          stream.push({ type: "error", reason: "aborted", error });
        },
        { once: true },
      );
      return stream;
    };
    const agent = new Agent({ apiKey: "离线密钥", streamFn });
    // 在请求入口取消，确保模型流已注册监听器。
    agent.streamFunction = (
      model: Model,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream | Promise<AssistantMessageEventStream> => {
      const result = streamFn(model, context, options);
      queueMicrotask((): void => agent.abort());
      return result;
    };
    await agent.prompt("问题");
    strictEqual(agent.state.errorMessage, "已取消");
    strictEqual(agent.state.pendingToolCalls.size, 0);
    strictEqual(agent.state.isStreaming, false);
    agent.abort();
  });

  it("工具执行前提交助手消息，执行事件更新 pendingToolCalls", async (): Promise<void> => {
    const target: AgentTool = {
      ...tool(),
      label: "工具",
      /**
       * 返回终止结果。
       * @returns 成功结果，要求停止自动续轮。
       */
      execute: async (): Promise<{ content: []; details: {}; terminate: boolean }> => ({
        content: [],
        details: {},
        terminate: true,
      }),
    };
    const agent = new Agent({
      apiKey: "离线密钥",
      initialState: { tools: [target] },
      streamFn: (): AssistantMessageEventStream => {
        const stream = new AssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "toolUse",
          message: assistant({
            content: [{ type: "toolCall", id: "call", name: target.name, arguments: { value: 0 } }],
            stopReason: "toolUse",
          }),
        });
        return stream;
      },
    });
    agent.beforeToolCall = async (context: BeforeToolCallContext): Promise<undefined> => {
      strictEqual(agent.state.messages.at(-1), context.assistantMessage);
      return undefined;
    };
    const pending: string[][] = [];
    agent.subscribe((event: AgentEvent): void => {
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        pending.push([...agent.state.pendingToolCalls]);
      }
    });
    await agent.prompt(user("执行"));
    deepStrictEqual(pending, [["call"], []]);
  });
});

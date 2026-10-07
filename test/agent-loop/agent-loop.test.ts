import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  agentLoop,
  agentLoopContinue,
  runAgentLoop,
  runAgentLoopContinue,
  runToolCall,
} from "../../src/agent-loop/agent-loop.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  AfterToolCallResult,
  BeforeToolCallContext,
  PrepareRequestContext,
  AgentRequestUpdate,
  AgentTurnContext,
  AgentTurnDecision,
  StreamFn,
} from "../../src/agent-loop/types.ts";
import {
  AssistantMessageEventStream,
  type EventStream,
} from "../../src/llm-api/utils/event-stream.ts";
import type {
  AssistantMessage,
  Message,
  SystemMessage,
  UserMessage,
  Model,
  TranscriptContext,
  SimpleStreamOptions,
} from "../../src/llm-api/types.ts";
import { getCurrentTools, toToolDeclaration } from "../../src/llm-api/utils/transcript.ts";
import { setDefaultStreamFn } from "../../src/agent-loop/stream-fn.ts";
import { testModel } from "../llm-api/fixtures.ts";
import { assistant, tool } from "../llm-api/helpers.ts";

/**
 * 创建独立的用户消息。
 * @returns 用于开始或继续循环的用户消息。
 */
function userMessage(): UserMessage {
  return { role: "user", content: "测试问题", timestamp: 1 };
}

/**
 * 创建包含离线认证值、消息转换和模型信息的循环配置。
 * @returns 不访问外部服务的配置。
 */
function loopConfig(): AgentLoopConfig {
  return {
    model: testModel("openai-completions"),
    apiKey: "测试密钥",
    /**
     * 保留测试中的标准模型消息。
     * @param messages - 测试上下文消息。
     * @returns 原始消息数组。
     */
    convertToLlm: (messages: AgentMessage[]): Message[] => messages,
  };
}

/**
 * 将给定助手消息依次作为内存模型响应返回。
 * @param messages - 每次模型请求的最终助手消息。
 * @returns 仅生成内存事件的流式请求函数。
 * @throws 请求次数超过提供的消息数量时抛出错误。
 */
function memoryStream(...messages: AssistantMessage[]): StreamFn {
  let index = 0;
  return (): AssistantMessageEventStream => {
    const message = messages[index++];
    if (!message) {
      throw new Error("内存响应数量不足");
    }
    if (message.stopReason === "pending") {
      throw new Error("内存响应必须提供最终停止原因");
    }
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
      return stream;
    }
    stream.push({ type: "done", reason: message.stopReason, message });
    return stream;
  };
}

/**
 * 消费代理事件流并取得最终消息。
 * @param stream - 本次运行的代理事件流。
 * @returns 发出的事件和最终新增消息。
 */
async function collectAgentStream(
  stream: EventStream<AgentEvent, AgentMessage[]>,
): Promise<{ events: AgentEvent[]; messages: AgentMessage[] }> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  const messages = await stream.result();
  return { events, messages };
}

/**
 * 创建参数值为零的工具调用。
 * @returns 对应测试工具的调用内容块。
 */
function toolCall(): AgentToolCall {
  return { type: "toolCall", id: "测试调用", name: "测试工具", arguments: { value: 0 } };
}

/**
 * 创建独立的工具执行结果。
 * @returns 文本结果与空详情。
 */
function toolResult(): AgentToolResult {
  return { content: [{ type: "text", text: "工具结果" }], details: {} };
}

/**
 * 创建可替换执行逻辑的测试工具。
 * @param execute - 工具执行函数；省略时返回固定成功结果。
 * @returns 具有数字参数模式的可执行工具。
 */
function executableTool(
  execute: AgentTool["execute"] = async (): Promise<AgentToolResult> => toolResult(),
): AgentTool {
  return { ...tool(), label: "测试工具", execute };
}

describe("agentLoop", (): void => {
  it("返回完整事件流且复制输入上下文的消息数组", async (): Promise<void> => {
    const previous = userMessage();
    const prompt = userMessage();
    const response = assistant();
    const context: AgentContext = { messages: [previous] };
    const stream = agentLoop([prompt], context, loopConfig(), undefined, memoryStream(response));
    const result = await collectAgentStream(stream);
    deepStrictEqual(result.messages, [prompt, response]);
    deepStrictEqual(context.messages, [previous]);
    strictEqual(result.events[0]?.type, "agent_start");
    strictEqual(result.events.at(-1)?.type, "agent_end");
  });

  it("空提示和空上下文仍可请求一轮", async (): Promise<void> => {
    const response = assistant({ content: [] });
    const stream = agentLoop([], { messages: [] }, loopConfig(), undefined, memoryStream(response));
    const result = await collectAgentStream(stream);
    deepStrictEqual(result.messages, [response]);
  });

  it("模型错误响应仍发出结束事件并返回错误消息", async (): Promise<void> => {
    const response = assistant({ stopReason: "error", errorMessage: "模型失败" });
    const stream = agentLoop([], { messages: [] }, loopConfig(), undefined, memoryStream(response));
    const result = await collectAgentStream(stream);
    deepStrictEqual(result.messages, [response]);
    strictEqual(result.events.at(-1)?.type, "agent_end");
  });
});

describe("agentLoopContinue", (): void => {
  it("仅返回新增消息并追加到原上下文数组", async (): Promise<void> => {
    const previous = userMessage();
    const response = assistant();
    const context: AgentContext = { messages: [previous] };
    const originalMessages = context.messages;
    const stream = agentLoopContinue(context, loopConfig(), undefined, memoryStream(response));
    const result = await collectAgentStream(stream);
    deepStrictEqual(result.messages, [response]);
    strictEqual(context.messages, originalMessages);
    deepStrictEqual(context.messages, [previous, response]);
  });

  it("空上下文同步抛出错误", (): void => {
    throws(
      (): unknown => agentLoopContinue({ messages: [] }, loopConfig(), undefined, memoryStream()),
      /Cannot continue: no messages in context/,
    );
  });

  it("末尾助手消息同步抛出错误", (): void => {
    throws(
      (): unknown =>
        agentLoopContinue({ messages: [assistant()] }, loopConfig(), undefined, memoryStream()),
      /Cannot continue from message role: assistant/,
    );
  });
});

describe("runAgentLoop", (): void => {
  for (const shouldKeepMessages of [true, false]) {
    it(`先变换再转换上下文，${shouldKeepMessages ? "裁剪" : "清空"}请求不修改历史`, async (): Promise<void> => {
      const previous = [userMessage(), assistant(), userMessage(), assistant()];
      const prompt = userMessage();
      const response = assistant();
      const ordering: string[] = [];
      const expected = shouldKeepMessages ? [previous[3], prompt] : [];
      const config = loopConfig();
      /**
       * 为本次请求裁剪消息，保留原始历史数组。
       * @param messages - 循环中的完整历史。
       * @returns 本次请求使用的消息副本。
       */
      config.transformContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
        ordering.push("transformContext");
        return shouldKeepMessages ? messages.slice(-2) : [];
      };
      /**
       * 验证转换接收变换后的消息，并异步返回模型消息。
       * @param messages - 变换后的消息。
       * @returns 模型请求消息。
       */
      config.convertToLlm = async (messages: AgentMessage[]): Promise<Message[]> => {
        ordering.push("convertToLlm");
        deepStrictEqual(messages, expected);
        return messages;
      };
      const streamFn = memoryStream(response);
      const messages = await runAgentLoop(
        [prompt],
        { messages: previous },
        config,
        (): void => {},
        undefined,
        (model, context, options) => {
          ordering.push("stream");
          deepStrictEqual(context.messages, expected);
          deepStrictEqual(Object.keys(context), ["messages"]);
          return streamFn(model, context, options);
        },
      );
      deepStrictEqual(ordering, ["transformContext", "convertToLlm", "stream"]);
      strictEqual(previous.length, 4);
      deepStrictEqual(messages, [prompt, response]);
    });
  }

  it("上下文回调违反不抛错约定时拒绝运行，不发送模型请求", async (): Promise<void> => {
    const failure = new Error("上下文变换失败");
    const config = loopConfig();
    /**
     * 模拟违反回调契约的上下文变换。
     * @param _messages - 当前消息。
     * @returns 不返回成功结果。
     * @throws 始终拒绝以验证低层循环的异常传播。
     */
    config.transformContext = async (_messages: AgentMessage[]): Promise<AgentMessage[]> => {
      throw failure;
    };
    let requests = 0;
    const execution = runAgentLoop(
      [userMessage()],
      { messages: [] },
      config,
      (): void => {},
      undefined,
      (): AssistantMessageEventStream => {
        requests++;
        return new AssistantMessageEventStream();
      },
    );
    await rejects(execution, failure);
    strictEqual(requests, 0);
  });

  it("流式文本更新按顺序发出且最终消息替换部分消息", async (): Promise<void> => {
    const prompt = userMessage();
    const partial = assistant({ content: [], stopReason: "pending" });
    const updated = assistant({ content: [{ type: "text", text: "你好" }], stopReason: "pending" });
    const response = assistant({ content: [{ type: "text", text: "你好" }] });
    const events: AgentEvent[] = [];
    const messages = await runAgentLoop(
      [prompt],
      { messages: [] },
      loopConfig(),
      (event: AgentEvent): void => {
        events.push(event);
      },
      undefined,
      (): AssistantMessageEventStream => {
        const stream = new AssistantMessageEventStream();
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "你好", partial: updated });
        stream.push({ type: "text_end", contentIndex: 0, content: "你好", partial: updated });
        stream.push({ type: "done", reason: "stop", message: response });
        return stream;
      },
    );
    deepStrictEqual(
      events.map((event: AgentEvent): string => event.type),
      [
        "agent_start",
        "turn_start",
        "message_start",
        "message_end",
        "message_start",
        "message_update",
        "message_update",
        "message_update",
        "message_end",
        "turn_end",
        "agent_end",
      ],
    );
    const updates = events.filter(
      (event: AgentEvent): event is Extract<AgentEvent, { type: "message_update" }> =>
        event.type === "message_update",
    );
    deepStrictEqual(
      updates.map((event): string => event.assistantMessageEvent.type),
      ["text_start", "text_delta", "text_end"],
    );
    deepStrictEqual(updates[1]?.message.content, updated.content);
    deepStrictEqual(messages, [prompt, response]);
    strictEqual(messages.at(-1), response);
  });

  for (const stopReason of ["stop", "error", "aborted"] as const) {
    it(`没有 start 事件的 ${stopReason} 响应仍发出完整结束事件`, async (): Promise<void> => {
      const response = assistant({ stopReason });
      const events: AgentEvent[] = [];
      const messages = await runAgentLoop(
        [],
        { messages: [] },
        loopConfig(),
        (event: AgentEvent): void => {
          events.push(event);
        },
        undefined,
        (): AssistantMessageEventStream => {
          const stream = new AssistantMessageEventStream();
          if (stopReason === "stop") {
            stream.push({ type: "done", reason: stopReason, message: response });
          } else {
            stream.push({ type: "error", reason: stopReason, error: response });
          }
          return stream;
        },
      );
      deepStrictEqual(
        events.map((event: AgentEvent): string => event.type),
        ["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"],
      );
      deepStrictEqual(messages, [response]);
    });
  }

  it("助手消息结束后才执行工具，部分结果先于工具结束和结果消息", async (): Promise<void> => {
    const target = executableTool(
      async (
        _toolCallId: string,
        _params: unknown,
        _signal?: AbortSignal,
        onUpdate?: (partialResult: AgentToolResult) => void,
      ): Promise<AgentToolResult> => {
        onUpdate?.(toolResult());
        return toolResult();
      },
    );
    const response = assistant({ content: [toolCall()], stopReason: "toolUse" });
    const events: AgentEvent[] = [];
    await runAgentLoop(
      [userMessage()],
      { messages: [], tools: [target] },
      loopConfig(),
      (event: AgentEvent): void => {
        events.push(event);
      },
      undefined,
      memoryStream(response, assistant()),
    );
    const ordering = events.flatMap((event: AgentEvent): string[] => {
      if (event.type === "message_end") {
        return [`message_end:${event.message.role}`];
      }
      if (event.type.startsWith("tool_execution_") || event.type === "turn_end") {
        return [event.type];
      }
      return [];
    });
    deepStrictEqual(ordering, [
      "message_end:system",
      "message_end:user",
      "message_end:assistant",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "message_end:toolResult",
      "turn_end",
      "message_end:assistant",
      "turn_end",
    ]);
  });

  it("等待事件回调并返回提示及响应且不修改原消息数组", async (): Promise<void> => {
    const prompt = userMessage();
    const response = assistant();
    const context: AgentContext = { messages: [] };
    const events: AgentEvent[] = [];
    const messages = await runAgentLoop(
      [prompt],
      context,
      loopConfig(),
      async (event: AgentEvent): Promise<void> => {
        await Promise.resolve();
        events.push(event);
      },
      undefined,
      memoryStream(response),
    );
    deepStrictEqual(messages, [prompt, response]);
    deepStrictEqual(context.messages, []);
    strictEqual(events.at(-1)?.type, "agent_end");
  });

  it("空提示允许执行且取消响应结束运行", async (): Promise<void> => {
    const response = assistant({ stopReason: "aborted" });
    const messages = await runAgentLoop(
      [],
      { messages: [] },
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(response),
    );
    deepStrictEqual(messages, [response]);
  });

  it("事件回调拒绝时原样拒绝运行", async (): Promise<void> => {
    const failure = new Error("事件回调失败");
    const execution = runAgentLoop(
      [],
      { messages: [] },
      loopConfig(),
      async (): Promise<void> => {
        throw failure;
      },
      undefined,
      memoryStream(),
    );
    await rejects(execution, failure);
  });

  it("工具错误回填模型上下文后继续请求并完成回答", async (): Promise<void> => {
    let executionCount = 0;
    const target = executableTool(async (): Promise<AgentToolResult> => {
      executionCount++;
      if (executionCount === 1) {
        throw new Error("工具执行失败");
      }
      return {
        content: [{ type: "text", text: "工具主动报告失败" }],
        details: { partial: true },
        isError: true,
      };
    });
    const calls: AgentToolCall[] = [
      { ...toolCall(), name: "missing" },
      { ...toolCall(), id: "参数错误", arguments: {} },
      { ...toolCall(), id: "执行抛错" },
      { ...toolCall(), id: "主动错误" },
    ];
    const response = assistant({ content: calls, stopReason: "toolUse" });
    const finalResponse = assistant();
    const streamFn = memoryStream(response, finalResponse);
    let requestCount = 0;
    const messages = await runAgentLoop(
      [userMessage()],
      { messages: [], tools: [target] },
      { ...loopConfig(), toolExecution: "sequential" },
      (): void => {},
      undefined,
      (model, context, options) => {
        requestCount++;
        if (requestCount === 2) {
          const results = context.messages.filter(
            (message): boolean => message.role === "toolResult",
          );
          strictEqual(results.length, 4);
          for (const result of results) {
            strictEqual(result.role, "toolResult");
            if (result.role === "toolResult") {
              strictEqual(result.isError, true);
            }
          }
        }
        return streamFn(model, context, options);
      },
    );
    strictEqual(executionCount, 2);
    strictEqual(requestCount, 2);
    strictEqual(messages.at(-1), finalResponse);
  });

  for (const toolExecution of ["sequential", "parallel"] as const) {
    it(`以 ${toolExecution} 执行工具后汇总结果并继续请求`, async (): Promise<void> => {
      const calls = [toolCall(), { ...toolCall(), id: "第二次调用" }];
      const firstResponse = assistant({ content: calls, stopReason: "toolUse" });
      const finalResponse = assistant();
      const context: AgentContext = { messages: [], tools: [executableTool()] };
      const config = { ...loopConfig(), toolExecution };
      const events: AgentEvent[] = [];
      const messages = await runAgentLoop(
        [userMessage()],
        context,
        config,
        (event: AgentEvent): void => {
          events.push(event);
        },
        undefined,
        memoryStream(firstResponse, finalResponse),
      );
      const toolResults = messages.filter(
        (message: AgentMessage): boolean => message.role === "toolResult",
      );
      strictEqual(toolResults.length, 2);
      const completedCalls = events.filter(
        (event: AgentEvent): boolean => event.type === "tool_execution_end",
      );
      strictEqual(completedCalls.length, 2);
      const completedTurns = events.filter(
        (event: AgentEvent): boolean => event.type === "turn_end",
      );
      strictEqual(completedTurns.length, 2);
      strictEqual(messages.at(-1), finalResponse);
      deepStrictEqual(context.messages, []);
    });
  }
});

describe("工具声明同步", (): void => {
  it("可执行工具变化合并到待发送系统消息，保留内容与命名区段", async (): Promise<void> => {
    const first = executableTool();
    const second = { ...executableTool(), name: "第二个工具" };
    const baseline: SystemMessage = {
      role: "system",
      content: "初始指令",
      toolsAdded: [toToolDeclaration(first)],
      timestamp: 1,
    };
    const pending: SystemMessage = {
      role: "system",
      content: "补充指令",
      sections: { note: "命名区段" },
      timestamp: 2,
    };
    const messages = await runAgentLoop(
      [pending, userMessage()],
      { messages: [baseline], tools: [second] },
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(assistant()),
    );
    deepStrictEqual(messages[0], {
      ...pending,
      toolsAdded: [toToolDeclaration(second)],
      toolsRemoved: [{ name: first.name }],
    });
    strictEqual(Object.hasOwn(pending, "toolsAdded"), false);
    deepStrictEqual(getCurrentTools([baseline, ...messages]), [toToolDeclaration(second)]);
    const system = messages[0];
    if (system?.role === "system") {
      strictEqual(Object.hasOwn(system.toolsAdded?.[0] ?? {}, "execute"), false);
    }
  });

  it("待发送消息中的错误声明按可执行工具集合改写", async (): Promise<void> => {
    const first = executableTool();
    const second = { ...executableTool(), name: "第二个工具" };
    const baseline: SystemMessage = {
      role: "system",
      content: "初始指令",
      toolsAdded: [toToolDeclaration(first)],
      timestamp: 1,
    };
    const pending: SystemMessage = {
      role: "system",
      content: "",
      sections: { note: "保留区段" },
      timestamp: 2,
      toolsAdded: [toToolDeclaration(second)],
      toolsRemoved: [{ name: first.name }],
    };
    const messages = await runAgentLoop(
      [pending, userMessage()],
      { messages: [baseline], tools: [first] },
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(assistant()),
    );
    deepStrictEqual(messages[0], {
      role: "system",
      content: "",
      sections: { note: "保留区段" },
      timestamp: 2,
    });
    deepStrictEqual(getCurrentTools([baseline, ...messages]), [toToolDeclaration(first)]);
    strictEqual(pending.toolsAdded?.[0]?.name, second.name);
  });

  it("工具集合未变化时不插入重复声明并保留待发送消息对象", async (): Promise<void> => {
    const target = executableTool();
    const baseline: SystemMessage = {
      role: "system",
      content: "初始指令",
      toolsAdded: [toToolDeclaration(target)],
      timestamp: 1,
    };
    const pending: SystemMessage = { role: "system", content: "补充指令", timestamp: 2 };
    const prompt = userMessage();
    const response = assistant();
    const messages = await runAgentLoop(
      [pending, prompt],
      { messages: [baseline], tools: [target] },
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(response),
    );
    deepStrictEqual(messages, [pending, prompt, response]);
    strictEqual(messages[0], pending);
  });
});

describe("请求准备与轮次决策", (): void => {
  it("首次请求在输入事件完成后替换上下文、模型和推理级别", async (): Promise<void> => {
    const prompt = userMessage();
    const canonical = { ...userMessage(), content: "规范上下文" };
    const replacement = { ...testModel("openai-completions"), id: "replacement" };
    const completed: AgentMessage[] = [];
    const config: AgentLoopConfig = {
      ...loopConfig(),
      /**
       * 输入提交后替换本次请求状态。
       * @param request - 待发送请求状态。
       * @returns 规范上下文、替换模型和推理级别。
       */
      prepareRequest: (request: PrepareRequestContext): AgentRequestUpdate => {
        strictEqual(completed.includes(prompt), true);
        strictEqual(request.context.messages.includes(prompt), true);
        return { context: { messages: [canonical] }, model: replacement, thinkingLevel: "high" };
      },
    };
    const streamFn = memoryStream(assistant());
    await runAgentLoop(
      [prompt],
      { messages: [] },
      config,
      (event: AgentEvent): void => {
        if (event.type === "message_end") {
          completed.push(event.message);
        }
      },
      undefined,
      (model, context, options) => {
        strictEqual(model, replacement);
        deepStrictEqual(context.messages, [canonical]);
        strictEqual(options?.reasoning, "high");
        return streamFn(model, context, options);
      },
    );
  });

  it("finishTurn 结束决定在 turn_end 后生效，不读取队列或准备下一轮", async (): Promise<void> => {
    const ordering: string[] = [];
    let polls = 0;
    const config: AgentLoopConfig = {
      ...loopConfig(),
      /**
       * 核对完整轮次后要求结束。
       * @param turn - 已完成的助手轮次。
       * @returns 结束决定。
       */
      finishTurn: (turn: AgentTurnContext): AgentTurnDecision => {
        strictEqual(turn.context.messages.at(-1), turn.message);
        ordering.push("finishTurn");
        return { action: "end" };
      },
      /**
       * 记录引导队列读取次数。
       * @returns 空队列。
       */
      getSteeringMessages: async (): Promise<AgentMessage[]> => {
        polls++;
        return [];
      },
      /**
       * 检测不应发生的后续队列读取。
       * @returns 不返回成功结果。
       * @throws 调用时抛出错误。
       */
      getFollowUpMessages: async (): Promise<AgentMessage[]> => {
        throw new Error("不应读取后续队列");
      },
      /**
       * 检测不应发生的下一轮准备。
       * @returns 不返回成功结果。
       * @throws 调用时抛出错误。
       */
      prepareNextTurn: (): undefined => {
        throw new Error("不应准备下一轮");
      },
    };
    await runAgentLoop(
      [userMessage()],
      { messages: [] },
      config,
      (event: AgentEvent): void => {
        if (event.type === "turn_end" || event.type === "agent_end") {
          ordering.push(event.type);
        }
      },
      undefined,
      memoryStream(assistant()),
    );
    deepStrictEqual(ordering, ["finishTurn", "turn_end", "agent_end"]);
    strictEqual(polls, 1);
  });

  it("工具结果触发的下一轮满足 continue 决定，不额外请求", async (): Promise<void> => {
    let turns = 0;
    const config: AgentLoopConfig = {
      ...loopConfig(),
      /**
       * 首轮要求继续，其余保留自然调度。
       * @returns 首轮继续决定，其余返回 undefined。
       */
      finishTurn: (): AgentTurnDecision | undefined => {
        turns++;
        return turns === 1 ? { action: "continue" } : undefined;
      },
    };
    const messages = await runAgentLoop(
      [userMessage()],
      { messages: [], tools: [executableTool()] },
      config,
      (): void => {},
      undefined,
      memoryStream(assistant({ content: [toolCall()], stopReason: "toolUse" }), assistant()),
    );
    strictEqual(turns, 2);
    strictEqual(messages.at(-1)?.role, "assistant");
  });
});

describe("引导与后续消息", (): void => {
  it("整批工具完成后注入引导消息，自然停止后才处理后续消息", async (): Promise<void> => {
    let executions = 0;
    const steering = { ...userMessage(), content: "引导" };
    const followUp = { ...userMessage(), content: "后续" };
    const queued: AgentMessage[] = [];
    const followUps: AgentMessage[] = [followUp];
    const target = executableTool(async (): Promise<AgentToolResult> => {
      executions++;
      if (executions === 1) {
        queued.push(steering);
      }
      return toolResult();
    });
    const requests: Message[][] = [];
    const config: AgentLoopConfig = {
      ...loopConfig(),
      toolExecution: "sequential",
      /**
       * 读取执行期间排队的引导消息。
       * @returns 当前排队消息并清空数组。
       */
      getSteeringMessages: async (): Promise<AgentMessage[]> => queued.splice(0),
      /**
       * 在自然停止时读取后续消息。
       * @returns 尚未处理的后续消息并清空数组。
       */
      getFollowUpMessages: async (): Promise<AgentMessage[]> => followUps.splice(0),
    };
    const streamFn = memoryStream(
      assistant({
        content: [toolCall(), { ...toolCall(), id: "第二次调用" }],
        stopReason: "toolUse",
      }),
      assistant(),
      assistant(),
    );
    const messages = await runAgentLoop(
      [userMessage()],
      { messages: [], tools: [target] },
      config,
      (): void => {},
      undefined,
      (model, context, options) => {
        requests.push(context.messages.slice());
        return streamFn(model, context, options);
      },
    );
    strictEqual(executions, 2);
    strictEqual(requests.length, 3);
    strictEqual(requests[0]?.includes(steering), false);
    strictEqual(requests[1]?.includes(steering), true);
    strictEqual(requests[1]?.includes(followUp), false);
    strictEqual(requests[2]?.includes(followUp), true);
    const results = messages.filter(
      (message: AgentMessage): boolean => message.role === "toolResult",
    );
    strictEqual(results.length, 2);
    for (const result of results) {
      strictEqual(messages.indexOf(result) < messages.indexOf(steering), true);
    }
    strictEqual(messages.indexOf(steering) < messages.indexOf(followUp), true);
  });

  for (const stopReason of ["error", "aborted"] as const) {
    it(`${stopReason}响应直接退出，不消耗排队消息`, async (): Promise<void> => {
      const queued = [userMessage()];
      let polls = 0;
      const config: AgentLoopConfig = {
        ...loopConfig(),
        /**
         * 启动时保留队列，后续读取才消耗消息。
         * @returns 启动时为空，其余读取返回排队消息。
         */
        getSteeringMessages: async (): Promise<AgentMessage[]> => {
          polls++;
          return polls === 1 ? [] : queued.splice(0);
        },
        /**
         * 模拟后续队列读取，错误退出时不应执行。
         * @returns 排队消息。
         */
        getFollowUpMessages: async (): Promise<AgentMessage[]> => queued.splice(0),
      };
      await runAgentLoop(
        [userMessage()],
        { messages: [] },
        config,
        (): void => {},
        undefined,
        memoryStream(assistant({ stopReason })),
      );
      strictEqual(polls, 1);
      strictEqual(queued.length, 1);
    });
  }
});

describe("工具批次调度", (): void => {
  it(
    "并行预检完成后执行，结束事件按完成顺序且结果按调用顺序",
    { timeout: 1000 },
    async (): Promise<void> => {
      const ordering: string[] = [];
      let releaseFirst = (): void => {};
      const firstDone = new Promise<void>((resolve): void => {
        releaseFirst = resolve;
      });
      const target = executableTool(async (id: string): Promise<AgentToolResult> => {
        ordering.push(`执行:${id}`);
        if (id === "测试调用") {
          await firstDone;
        }
        return toolResult();
      });
      const calls = [toolCall(), { ...toolCall(), id: "第二次调用" }];
      const config = loopConfig();
      /**
       * 记录工具预检顺序。
       * @param context - 当前调用上下文。
       * @returns 允许执行工具。
       */
      config.beforeToolCall = async (context: BeforeToolCallContext): Promise<undefined> => {
        ordering.push(`预检:${context.toolCall.id}`);
        return undefined;
      };
      const events: AgentEvent[] = [];
      try {
        const messages = await runAgentLoop(
          [userMessage()],
          { messages: [], tools: [target] },
          config,
          (event: AgentEvent): void => {
            events.push(event);
            if (event.type === "tool_execution_end" && event.toolCallId === "第二次调用") {
              releaseFirst();
            }
          },
          undefined,
          memoryStream(assistant({ content: calls, stopReason: "toolUse" }), assistant()),
        );
        deepStrictEqual(ordering, [
          "预检:测试调用",
          "预检:第二次调用",
          "执行:测试调用",
          "执行:第二次调用",
        ]);
        const endIds = events.flatMap((event: AgentEvent): string[] =>
          event.type === "tool_execution_end" ? [event.toolCallId] : [],
        );
        const messageIds = messages.flatMap((message: AgentMessage): string[] =>
          message.role === "toolResult" ? [message.toolCallId] : [],
        );
        const turnIds = events.flatMap((event: AgentEvent): string[] =>
          event.type === "turn_end"
            ? event.toolResults.map((result): string => result.toolCallId)
            : [],
        );
        deepStrictEqual(endIds, ["第二次调用", "测试调用"]);
        deepStrictEqual(messageIds, ["测试调用", "第二次调用"]);
        deepStrictEqual(turnIds, messageIds);
      } finally {
        releaseFirst();
      }
    },
  );

  for (const mode of ["全局串行", "单工具串行", "全部并行"] as const) {
    it(`${mode}控制混合工具批次的并发数量`, async (): Promise<void> => {
      let active = 0;
      let maxActive = 0;
      const first = executableTool(async (): Promise<AgentToolResult> => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        return toolResult();
      });
      const second = { ...first, name: "第二个工具", executionMode: "parallel" as const };
      first.executionMode = mode === "单工具串行" ? "sequential" : "parallel";
      const calls = [toolCall(), { ...toolCall(), id: "第二次调用", name: second.name }];
      await runAgentLoop(
        [userMessage()],
        { messages: [], tools: [first, second] },
        { ...loopConfig(), toolExecution: mode === "全局串行" ? "sequential" : "parallel" },
        (): void => {},
        undefined,
        memoryStream(assistant({ content: calls, stopReason: "toolUse" }), assistant()),
      );
      strictEqual(maxActive, mode === "全部并行" ? 2 : 1);
    });
  }
});

describe("runAgentLoopContinue", (): void => {
  it("复用原消息数组并仅返回本次响应", async (): Promise<void> => {
    const previous = userMessage();
    const response = assistant();
    const context: AgentContext = { messages: [previous] };
    const originalMessages = context.messages;
    const messages = await runAgentLoopContinue(
      context,
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(response),
    );
    deepStrictEqual(messages, [response]);
    strictEqual(context.messages, originalMessages);
    deepStrictEqual(context.messages, [previous, response]);
  });

  it("空上下文拒绝运行", async (): Promise<void> => {
    const execution = runAgentLoopContinue(
      { messages: [] },
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(),
    );
    await rejects(execution, /Cannot continue: no messages in context/);
  });

  it("末尾助手消息拒绝运行", async (): Promise<void> => {
    const execution = runAgentLoopContinue(
      { messages: [assistant()] },
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(),
    );
    await rejects(execution, /Cannot continue from message role: assistant/);
  });
});

describe("runToolCall", (): void => {
  it("参数准备先于校验和执行，原始调用保持不变", async (): Promise<void> => {
    const call = { ...toolCall(), arguments: {} };
    let received: unknown;
    const target = executableTool(
      async (_id: string, params: unknown): Promise<AgentToolResult> => {
        received = params;
        return toolResult();
      },
    );
    /**
     * 将旧参数格式转换为当前工具模式接受的参数。
     * @param args - 原始参数。
     * @returns 带必填数字的参数对象。
     */
    target.prepareArguments = (args: unknown): { value: number } => {
      deepStrictEqual(args, {});
      return { value: 1 };
    };
    const result = await runToolCall(call, {
      tools: [target],
      assistantMessage: assistant(),
      context: { messages: [] },
      /**
       * 验证钩子同时收到原始调用和校验后的参数。
       * @param context - 调用前上下文。
       * @returns 允许执行。
       */
      beforeToolCall: async (context: BeforeToolCallContext): Promise<undefined> => {
        deepStrictEqual(context.toolCall.arguments, {});
        deepStrictEqual(context.args, { value: 1 });
        return undefined;
      },
    });
    strictEqual(result.isError, false);
    deepStrictEqual(received, { value: 1 });
    deepStrictEqual(call.arguments, {});
  });

  it("调用前阻止时跳过工具执行和调用后钩子", async (): Promise<void> => {
    const stages: string[] = [];
    const target = executableTool(async (): Promise<AgentToolResult> => {
      stages.push("执行");
      return toolResult();
    });
    const result = await runToolCall(toolCall(), {
      tools: [target],
      assistantMessage: assistant(),
      context: { messages: [] },
      /**
       * 阻止已通过校验的调用。
       * @returns 阻止原因。
       */
      beforeToolCall: async (): Promise<{ block: boolean; reason: string }> => {
        stages.push("调用前");
        return { block: true, reason: "禁止执行" };
      },
      /**
       * 记录调用后钩子是否被执行。
       * @returns 保留结果。
       */
      afterToolCall: async (): Promise<undefined> => {
        stages.push("调用后");
        return undefined;
      },
    });
    strictEqual(result.isError, true);
    deepStrictEqual(result.result.content, [{ type: "text", text: "禁止执行" }]);
    deepStrictEqual(stages, ["调用前"]);
  });

  it("调用后钩子按字段覆盖，内容替换时同步处理结构化结果", async (): Promise<void> => {
    const target = executableTool(async (): Promise<AgentToolResult> => ({
      ...toolResult(),
      structuredContent: { value: "original" },
    }));
    const content = [{ type: "text" as const, text: "替换内容" }];
    const overrides: AfterToolCallResult[] = [
      { content },
      { structuredContent: { value: "replaced" } },
      { content, structuredContent: { value: "both" } },
      { details: { note: "kept" } },
    ];
    const seen: unknown[] = [];
    for (const override of overrides) {
      const result = await runToolCall(toolCall(), {
        tools: [target],
        assistantMessage: assistant(),
        context: { messages: [] },
        /**
         * 返回本次覆盖项。
         * @returns 要替换的结果字段。
         */
        afterToolCall: async (): Promise<AfterToolCallResult> => override,
      });
      seen.push(result.result.structuredContent);
    }
    deepStrictEqual(seen, [
      undefined,
      { value: "replaced" },
      { value: "both" },
      { value: "original" },
    ]);
  });

  it("参数类型错误不执行工具，也不进入调用前后的回调", async (): Promise<void> => {
    const stages: string[] = [];
    const target = executableTool(async (): Promise<AgentToolResult> => {
      stages.push("执行");
      return toolResult();
    });
    const call = { ...toolCall(), arguments: { value: { nested: true } } };
    const result = await runToolCall(call, {
      tools: [target],
      assistantMessage: assistant(),
      context: { messages: [] },
      /**
       * 记录调用前回调，校验失败时不应进入。
       * @returns Promise 完成后允许执行。
       */
      beforeToolCall: async (): Promise<undefined> => {
        stages.push("调用前");
        return undefined;
      },
      /**
       * 记录调用后回调，校验失败时不应进入。
       * @returns Promise 完成后保持原结果。
       */
      afterToolCall: async (): Promise<undefined> => {
        stages.push("调用后");
        return undefined;
      },
    });
    strictEqual(result.isError, true);
    deepStrictEqual(stages, []);
    deepStrictEqual(call.arguments, { value: { nested: true } });
  });

  it("工具主动返回错误时保留结果内容与详情", async (): Promise<void> => {
    const target = executableTool(async (): Promise<AgentToolResult> => ({
      content: [{ type: "text", text: "工具失败" }],
      details: { partial: true },
      isError: true,
    }));
    const result = await runToolCall(toolCall(), {
      tools: [target],
      assistantMessage: assistant(),
      context: { messages: [] },
    });
    strictEqual(result.isError, true);
    deepStrictEqual(result.result.content, [{ type: "text", text: "工具失败" }]);
    deepStrictEqual(result.result.details, { partial: true });
  });

  it("执行工具并依次应用调用前后的回调", async (): Promise<void> => {
    const stages: string[] = [];
    const target = executableTool(async (): Promise<AgentToolResult> => {
      stages.push("执行");
      return toolResult();
    });
    const result = await runToolCall(toolCall(), {
      tools: [target],
      assistantMessage: assistant(),
      context: { messages: [] },
      /**
       * 记录调用前回调的执行顺序。
       * @returns Promise 完成后返回 undefined，允许继续执行工具。
       */
      beforeToolCall: async (): Promise<undefined> => {
        stages.push("调用前");
        return undefined;
      },
      /**
       * 记录调用后回调的执行顺序并替换结果文本。
       * @returns Promise 完成后得到工具内容覆盖项。
       */
      afterToolCall: async (): Promise<{ content: { type: "text"; text: string }[] }> => {
        stages.push("调用后");
        return { content: [{ type: "text", text: "替换结果" }] };
      },
    });
    deepStrictEqual(stages, ["调用前", "执行", "调用后"]);
    strictEqual(result.isError, false);
    deepStrictEqual(result.result.content, [{ type: "text", text: "替换结果" }]);
  });

  it("未知工具和缺失必填参数作为错误结果返回", async (): Promise<void> => {
    for (const call of [toolCall(), { ...toolCall(), arguments: {} }]) {
      const result = await runToolCall(call, {
        tools: Object.keys(call.arguments).length === 0 ? [executableTool()] : [],
        assistantMessage: assistant(),
        context: { messages: [] },
      });
      strictEqual(result.isError, true);
    }
  });

  it("工具执行抛错作为错误结果返回", async (): Promise<void> => {
    const target = executableTool(async (): Promise<AgentToolResult> => {
      throw new Error("工具执行失败");
    });
    const result = await runToolCall(toolCall(), {
      tools: [target],
      assistantMessage: assistant(),
      context: { messages: [] },
    });
    strictEqual(result.isError, true);
    deepStrictEqual(result.result.content, [{ type: "text", text: "工具执行失败" }]);
  });

  it("部分结果回调返回拒绝的 Promise 时运行仍会拒绝", async (): Promise<void> => {
    const failure = new Error("部分结果回调失败");
    const target = executableTool(
      async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: (partialResult: AgentToolResult) => void,
      ): Promise<AgentToolResult> => {
        onUpdate?.(toolResult());
        return toolResult();
      },
    );
    const execution = runToolCall(toolCall(), {
      tools: [target],
      assistantMessage: assistant(),
      context: { messages: [] },
      /**
       * 模拟部分结果回调失败。
       * @returns Promise 始终拒绝，不产生成功结果。
       * @throws 拒绝 Promise 时返回本测试的固定错误。
       */
      onUpdate: async (): Promise<void> => {
        throw failure;
      },
    });
    await rejects(execution, failure);
  });
});

describe("真实演示之外的循环边界", (): void => {
  for (const mode of ["全部终止", "部分终止", "钩子终止"] as const) {
    it(`${mode}根据全部最终工具结果决定是否继续请求`, async (): Promise<void> => {
      const target = executableTool(async (id: string): Promise<AgentToolResult> => ({
        ...toolResult(),
        terminate: mode === "全部终止" || (mode === "部分终止" && id === "测试调用"),
      }));
      const config = loopConfig();
      if (mode === "钩子终止") {
        /**
         * 将最终工具结果标记为终止。
         * @returns 批次终止提示。
         */
        config.afterToolCall = async (): Promise<AfterToolCallResult> => ({ terminate: true });
      }
      const response = assistant({
        content: [toolCall(), { ...toolCall(), id: "第二次调用" }],
        stopReason: "toolUse",
      });
      const final = assistant();
      const messages = await runAgentLoop(
        [userMessage()],
        { messages: [], tools: [target] },
        config,
        (): void => {},
        undefined,
        memoryStream(response, ...(mode === "部分终止" ? [final] : [])),
      );
      strictEqual(messages.at(-1)?.role, mode === "部分终止" ? "assistant" : "toolResult");
      const results = messages.filter(
        (message: AgentMessage): message is Extract<AgentMessage, { role: "toolResult" }> =>
          message.role === "toolResult",
      );
      strictEqual(results.length, 2);
      for (const result of results) {
        strictEqual(Object.hasOwn(result, "terminate"), false);
      }
    });
  }

  for (const toolExecution of ["sequential", "parallel"] as const) {
    it(`${toolExecution}预检期间取消后不执行工具或预检后续调用`, async (): Promise<void> => {
      const controller = new AbortController();
      let executions = 0;
      let preparations = 0;
      const target = executableTool(async (): Promise<AgentToolResult> => {
        executions++;
        return toolResult();
      });
      const config: AgentLoopConfig = {
        ...loopConfig(),
        toolExecution,
        /**
         * 在首个工具预检期间取消运行。
         * @param context - 当前工具上下文。
         * @param signal - 传入预检的运行信号。
         * @returns 取消后不附加阻止决定。
         */
        beforeToolCall: async (
          context: BeforeToolCallContext,
          signal?: AbortSignal,
        ): Promise<undefined> => {
          strictEqual(context.toolCall.id, "测试调用");
          strictEqual(signal, controller.signal);
          preparations++;
          controller.abort();
          return undefined;
        },
      };
      const messages = await runAgentLoop(
        [userMessage()],
        { messages: [], tools: [target] },
        config,
        (): void => {},
        controller.signal,
        memoryStream(
          assistant({
            content: [toolCall(), { ...toolCall(), id: "第二次调用" }],
            stopReason: "toolUse",
          }),
          assistant({ stopReason: "aborted", errorMessage: "已取消" }),
        ),
      );
      strictEqual(executions, 0);
      strictEqual(preparations, 1);
      const results = messages.filter(
        (message: AgentMessage): message is Extract<AgentMessage, { role: "toolResult" }> =>
          message.role === "toolResult",
      );
      strictEqual(results.length, 1);
      strictEqual(results[0]?.isError, true);
      deepStrictEqual(results[0]?.content, [{ type: "text", text: "Operation aborted" }]);
      strictEqual(messages.at(-1)?.role, "assistant");
    });
  }

  it("length 截断工具调用不执行并回填错误后继续", async (): Promise<void> => {
    let executions = 0;
    const target = executableTool(async (): Promise<AgentToolResult> => {
      executions++;
      return toolResult();
    });
    const truncated = assistant({ content: [toolCall()], stopReason: "length" });
    const final = assistant();
    const messages = await runAgentLoop(
      [userMessage()],
      { messages: [], tools: [target] },
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(truncated, final),
    );
    strictEqual(executions, 0);
    const result = messages.find((message: AgentMessage): boolean => message.role === "toolResult");
    strictEqual(result?.role, "toolResult");
    if (result?.role === "toolResult") {
      strictEqual(result.isError, true);
      const text = result.content[0];
      strictEqual(text?.type, "text");
      if (text?.type === "text") {
        strictEqual(text.text.includes("output token limit"), true);
      }
    }
    strictEqual(messages.at(-1), final);
  });

  it("全部阻止结果 terminate 为 true 时不发起额外模型请求", async (): Promise<void> => {
    let executions = 0;
    const target = executableTool(async (): Promise<AgentToolResult> => {
      executions++;
      return toolResult();
    });
    const config: AgentLoopConfig = {
      ...loopConfig(),
      /**
       * 阻止演示调用并请求批次结束后终止。
       * @returns 阻止执行及终止的决定。
       */
      beforeToolCall: async (): Promise<{ block: true; terminate: true }> => ({
        block: true,
        terminate: true,
      }),
    };
    const messages = await runAgentLoop(
      [userMessage()],
      { messages: [], tools: [target] },
      config,
      (): void => {},
      undefined,
      memoryStream(assistant({ content: [toolCall()], stopReason: "toolUse" })),
    );
    strictEqual(executions, 0);
    strictEqual(messages.at(-1)?.role, "toolResult");
  });

  it("finishTurn 只请求一次显式继续并在第二轮结束", async (): Promise<void> => {
    let turns = 0;
    const config: AgentLoopConfig = {
      ...loopConfig(),
      /**
       * 第一轮继续，第二轮结束。
       * @returns 当前轮次的调度决定。
       */
      finishTurn: (): { action: "continue" | "end" } => {
        turns++;
        return { action: turns === 1 ? "continue" : "end" };
      },
    };
    const messages = await runAgentLoop(
      [userMessage()],
      { messages: [] },
      config,
      (): void => {},
      undefined,
      memoryStream(assistant(), assistant()),
    );
    strictEqual(turns, 2);
    strictEqual(
      messages.filter((message: AgentMessage): boolean => message.role === "assistant").length,
      2,
    );
  });

  it("仅替换 content 时移除不匹配的 structuredContent", async (): Promise<void> => {
    const target = executableTool(async (): Promise<AgentToolResult> => ({
      ...toolResult(),
      structuredContent: { value: 1 },
    }));
    const outcome = await runToolCall(toolCall(), {
      tools: [target],
      assistantMessage: assistant(),
      context: { messages: [] },
      /**
       * 仅覆盖面向模型的文本。
       * @returns 新的结果文本，不保留旧结构化内容。
       */
      afterToolCall: async (): Promise<{ content: [{ type: "text"; text: string }] }> => ({
        content: [{ type: "text", text: "覆盖" }],
      }),
    });
    strictEqual(outcome.result.structuredContent, undefined);
    deepStrictEqual(outcome.result.content, [{ type: "text", text: "覆盖" }]);
  });
});

describe("循环响应结算与工具取消边界", (): void => {
  for (const hasPartial of [false, true]) {
    it(`没有终结事件且${hasPartial ? "存在" : "不存在"}部分消息时采用流的最终结果`, async (): Promise<void> => {
      const final = assistant();
      const events: AgentEvent[] = [];
      const messages = await runAgentLoop(
        [userMessage()],
        { messages: [] },
        loopConfig(),
        (event: AgentEvent): void => {
          events.push(event);
        },
        undefined,
        (): AssistantMessageEventStream => {
          const stream = new AssistantMessageEventStream();
          if (hasPartial) {
            stream.push({
              type: "start",
              partial: assistant({ content: [], stopReason: "pending" }),
            });
          }
          stream.end(final);
          return stream;
        },
      );
      deepStrictEqual(messages, [userMessage(), final]);
      const starts = events.filter((event: AgentEvent): boolean => event.type === "message_start");
      strictEqual(starts.length, 2);
      const ends = events.filter((event: AgentEvent): boolean => event.type === "message_end");
      strictEqual(ends.length, 2);
      if (ends[1]?.type === "message_end") {
        strictEqual(ends[1].message, final);
      }
    });
  }

  it("并行工具预检后续调用取消时不启动已准备的工具", async (): Promise<void> => {
    const controller = new AbortController();
    let executions = 0;
    const target = executableTool(async (): Promise<AgentToolResult> => {
      executions++;
      return toolResult();
    });
    const config = loopConfig();
    /**
     * 第二个调用准备期间取消整个批次。
     * @param context - 当前工具调用上下文。
     * @returns 不附加阻止决定。
     */
    config.beforeToolCall = async (context: BeforeToolCallContext): Promise<undefined> => {
      if (context.toolCall.id === "第二次调用") {
        controller.abort();
      }
      return undefined;
    };
    const messages = await runAgentLoop(
      [userMessage()],
      { messages: [], tools: [target] },
      config,
      (): void => {},
      controller.signal,
      memoryStream(
        assistant({
          content: [toolCall(), { ...toolCall(), id: "第二次调用" }],
          stopReason: "toolUse",
        }),
        assistant({ stopReason: "aborted" }),
      ),
    );
    strictEqual(executions, 0);
    const results = messages.filter(
      (message: AgentMessage): boolean => message.role === "toolResult",
    );
    strictEqual(results.length, 2);
    for (const result of results) {
      if (result.role === "toolResult") {
        strictEqual(result.isError, true);
        deepStrictEqual(result.content, [{ type: "text", text: "Operation aborted" }]);
      }
    }
  });

  it("原样准备参数保留调用对象，完成后的部分结果不再传播", async (): Promise<void> => {
    let lateUpdate: ((result: AgentToolResult) => void) | undefined;
    const updates: AgentToolResult[] = [];
    const call = toolCall();
    const target = executableTool(
      async (
        _id: string,
        _params: unknown,
        _signal?: AbortSignal,
        onUpdate?: (result: AgentToolResult) => void,
      ): Promise<AgentToolResult> => {
        lateUpdate = onUpdate;
        onUpdate?.(toolResult());
        return toolResult();
      },
    );
    /**
     * 保留原始参数对象。
     * @param args - 原始调用参数。
     * @returns 同一个参数对象。
     */
    target.prepareArguments = (args: unknown): unknown => args;
    const outcome = await runToolCall(call, {
      tools: [target],
      assistantMessage: assistant(),
      context: { messages: [] },
      /**
       * 保存完成前的部分结果。
       * @param result - 当前部分结果。
       */
      onUpdate: (result: AgentToolResult): void => {
        updates.push(result);
      },
    });
    strictEqual(outcome.toolCall, call);
    strictEqual(outcome.isError, false);
    lateUpdate?.(toolResult());
    strictEqual(updates.length, 1);
  });

  it("已取消且无预检钩子的单次调用返回取消结果，不执行工具", async (): Promise<void> => {
    const controller = new AbortController();
    controller.abort();
    let executions = 0;
    const target = executableTool(async (): Promise<AgentToolResult> => {
      executions++;
      return toolResult();
    });
    const outcome = await runToolCall(toolCall(), {
      tools: [target],
      assistantMessage: assistant(),
      context: { messages: [] },
      signal: controller.signal,
    });
    strictEqual(executions, 0);
    strictEqual(outcome.isError, true);
    deepStrictEqual(outcome.result.content, [{ type: "text", text: "Operation aborted" }]);
  });
});

describe("并行工具准备与启动之间的取消", (): void => {
  it("参数准备排入的取消微任务阻止已准备调用和后续预检", async (): Promise<void> => {
    const controller = new AbortController();
    let preparations = 0;
    let executions = 0;
    const target = executableTool(async (): Promise<AgentToolResult> => {
      executions++;
      return toolResult();
    });
    /**
     * 在参数准备完成后的微任务阶段取消运行。
     * @param args - 原始调用参数。
     * @returns 原参数对象。
     */
    target.prepareArguments = (args: unknown): unknown => {
      preparations++;
      queueMicrotask((): void => controller.abort());
      return args;
    };
    const messages = await runAgentLoop(
      [userMessage()],
      { messages: [], tools: [target] },
      loopConfig(),
      (): void => {},
      controller.signal,
      memoryStream(
        assistant({
          content: [toolCall(), { ...toolCall(), id: "第二次调用" }],
          stopReason: "toolUse",
        }),
        assistant({ stopReason: "aborted" }),
      ),
    );
    strictEqual(preparations, 1);
    strictEqual(executions, 0);
    const results = messages.filter(
      (message: AgentMessage): boolean => message.role === "toolResult",
    );
    strictEqual(results.length, 1);
    if (results[0]?.role === "toolResult") {
      strictEqual(results[0].isError, true);
      deepStrictEqual(results[0].content, [{ type: "text", text: "Operation aborted" }]);
    }
  });
});

describe("可选轮次字段及钩子异常", (): void => {
  for (const level of [undefined, "off", "high"] as const) {
    it(`下一轮准备${level === undefined ? "省略" : `设置 ${level}`}推理级别时保留其他请求字段`, async (): Promise<void> => {
      const seen: (string | undefined)[] = [];
      let turns = 0;
      const config = loopConfig();
      config.reasoning = "low";
      /**
       * 仅提供当前用例需要的推理字段。
       * @returns 其余上下文和模型沿用当前值。
       */
      config.prepareRequest = (): AgentRequestUpdate => ({});
      /**
       * 第一轮继续，第二轮停止。
       * @returns 当前轮次决定。
       */
      config.finishTurn = (): AgentTurnDecision => ({ action: ++turns === 1 ? "continue" : "end" });
      /**
       * 仅替换第二轮的推理设置。
       * @returns 不携带上下文、模型或追加消息的更新。
       */
      config.prepareNextTurn = (): { thinkingLevel?: "off" | "high" } => ({ thinkingLevel: level });
      const stream = memoryStream(assistant(), assistant());
      await runAgentLoop(
        [userMessage()],
        { messages: [] },
        config,
        (): void => {},
        undefined,
        (
          model: Model,
          context: TranscriptContext,
          options?: SimpleStreamOptions,
        ): ReturnType<StreamFn> => {
          seen.push(options?.reasoning);
          return stream(model, context, options);
        },
      );
      deepStrictEqual(seen, [
        "low",
        level === undefined ? "low" : level === "off" ? undefined : "high",
      ]);
    });
  }

  for (const hook of ["prepareArguments", "execute", "afterToolCall"] as const) {
    it(`${hook}抛出非 Error 值时保留错误文本且标记失败`, async (): Promise<void> => {
      const target = executableTool();
      if (hook === "prepareArguments") {
        /**
         * 用字符串异常模拟参数准备失败。
         * @returns 不返回参数。
         * @throws 固定字符串异常。
         */
        target.prepareArguments = (): never => {
          throw "钩子字符串错误";
        };
      }
      if (hook === "execute") {
        /**
         * 用字符串异常模拟执行失败。
         * @returns 不返回结果。
         * @throws 固定字符串异常。
         */
        target.execute = async (): Promise<never> => {
          throw "钩子字符串错误";
        };
      }
      const outcome = await runToolCall(toolCall(), {
        tools: [target],
        assistantMessage: assistant(),
        context: { messages: [] },
        /**
         * 在调用后阶段模拟字符串异常，其他用例不修改结果。
         * @returns 不覆盖结果。
         * @throws 调用后异常用例抛出固定字符串。
         */
        afterToolCall: async (): Promise<undefined> => {
          if (hook === "afterToolCall") {
            throw "钩子字符串错误";
          }
          return undefined;
        },
      });
      strictEqual(outcome.isError, true);
      deepStrictEqual(outcome.result.content, [{ type: "text", text: "钩子字符串错误" }]);
    });
  }
});

describe("默认流与工具可选字段", (): void => {
  it("未显式传流函数时两个运行入口使用已配置默认流", async (): Promise<void> => {
    setDefaultStreamFn(memoryStream(assistant(), assistant()));
    try {
      const prompted = await runAgentLoop(
        [userMessage()],
        { messages: [] },
        loopConfig(),
        (): void => {},
        undefined,
        undefined as unknown as StreamFn,
      );
      const continued = await runAgentLoopContinue(
        { messages: [userMessage()] },
        loopConfig(),
        (): void => {},
        undefined,
        undefined as unknown as StreamFn,
      );
      strictEqual(prompted.at(-1)?.role, "assistant");
      strictEqual(continued.at(-1)?.role, "assistant");
    } finally {
      setDefaultStreamFn(undefined);
    }
  });

  it("无提示但有工具时插入声明，无工具数组时未知调用回填错误", async (): Promise<void> => {
    const target = executableTool();
    const declared = await runAgentLoop(
      [],
      { messages: [], tools: [target] },
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(assistant()),
    );
    strictEqual(declared[0]?.role, "system");
    if (declared[0]?.role === "system") {
      deepStrictEqual(declared[0].toolsAdded, [toToolDeclaration(target)]);
    }
    const unknown = await runAgentLoop(
      [userMessage()],
      { messages: [] },
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(assistant({ content: [toolCall()], stopReason: "toolUse" }), assistant()),
    );
    const result = unknown.find((message: AgentMessage): boolean => message.role === "toolResult");
    if (result?.role === "toolResult") {
      strictEqual(result.isError, true);
      deepStrictEqual(result.content, [{ type: "text", text: "Tool 测试工具 not found" }]);
    } else {
      strictEqual(result?.role, "toolResult");
    }
  });

  it("没有外部部分结果回调仍接受工具更新，调用后 Error 异常转为失败", async (): Promise<void> => {
    const target = executableTool(
      async (
        _id: string,
        _params: unknown,
        _signal?: AbortSignal,
        onUpdate?: (result: AgentToolResult) => void,
      ): Promise<AgentToolResult> => {
        onUpdate?.(toolResult());
        return toolResult();
      },
    );
    const result = await runToolCall(toolCall(), {
      tools: [target],
      assistantMessage: assistant(),
      context: { messages: [] },
      /**
       * 模拟调用后钩子的标准异常。
       * @returns 不产生覆盖值。
       * @throws 固定 Error 异常。
       */
      afterToolCall: async (): Promise<never> => {
        throw new Error("调用后失败");
      },
    });
    strictEqual(result.isError, true);
    deepStrictEqual(result.result.content, [{ type: "text", text: "调用后失败" }]);
  });
});

describe("工具结果的缺省内容", (): void => {
  it("运行时工具未提供 content 时回填空内容而不污染对话", async (): Promise<void> => {
    const target = executableTool(
      async (): Promise<AgentToolResult> => ({ details: {}, terminate: true }) as AgentToolResult,
    );
    const messages = await runAgentLoop(
      [userMessage()],
      { messages: [], tools: [target] },
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(assistant({ content: [toolCall()], stopReason: "toolUse" })),
    );
    const result = messages.at(-1);
    strictEqual(result?.role, "toolResult");
    if (result?.role === "toolResult") {
      deepStrictEqual(result.content, []);
      strictEqual(result.isError, false);
    }
  });
});

describe("空工具移除声明", (): void => {
  it("没有工具变更且 toolsRemoved 为空时保留系统消息对象", async (): Promise<void> => {
    const prompt: SystemMessage = {
      role: "system",
      content: "保持指令",
      timestamp: 1,
      toolsRemoved: [],
    };
    const messages = await runAgentLoop(
      [prompt, userMessage()],
      { messages: [] },
      loopConfig(),
      (): void => {},
      undefined,
      memoryStream(assistant()),
    );
    strictEqual(messages[0], prompt);
    deepStrictEqual(prompt.toolsRemoved, []);
  });
});

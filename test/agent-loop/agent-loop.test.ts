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
  StreamFn,
} from "../../src/agent-loop/types.ts";
import {
  AssistantMessageEventStream,
  type EventStream,
} from "../../src/llm-api/utils/event-stream.ts";
import type { AssistantMessage, Message, UserMessage } from "../../src/llm-api/types.ts";
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

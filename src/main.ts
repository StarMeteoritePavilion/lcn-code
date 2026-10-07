import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { loadAiConfig, type ResolvedAiConfig } from "./config/index.ts";
import {
  Type,
  stream,
  createAssistantMessageEventStream,
  getCurrentTools,
  getSupportedThinkingLevels,
  type Api,
  type ApiStreamOptions,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type ImageContent,
  type FetchFunction,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage,
} from "./llm-api/index.ts";
import {
  adjustMaxTokensForThinking,
  clampMaxTokensToContext,
  clampThinkingBudgetToAnswerRoom,
} from "./llm-api/api/simple-options.ts";
import {
  agentLoop,
  agentLoopContinue,
  runAgentLoop,
  runAgentLoopContinue,
  runToolCall,
} from "./agent-loop/agent-loop.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  AgentToolUpdateCallback,
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AgentTurnContext,
  AgentTurnDecision,
  AgentLoopTurnUpdate,
  PrepareRequestContext,
  AgentRequestUpdate,
} from "./agent-loop/types.ts";

type DemoTool = AgentTool<typeof PARAMETERS, { value: number }>;
interface Trace {
  requests: number;
  events: AgentEvent[];
  order: string[];
  starts: string[];
  ends: string[];
  active: number;
  maxActive: number;
  prepared: number;
  nested: number;
  before: number;
  after: number;
  sawSteering: boolean;
  sawFollowUp: boolean;
  toolSets: string[][];
}
interface DemoRun {
  trace: Trace;
  context: AgentContext;
  activeContext: AgentContext;
  loopConfig: AgentLoopConfig;
  signal: AbortSignal;
  cancellation: AbortController;
  forceTools: Map<number, string>;
  emit: (event: AgentEvent) => void;
  streamFn: (
    model: Model<Api>,
    transcript: TranscriptContext,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
  inspectTranscript?: (transcript: TranscriptContext) => void;
}

const PARAMETERS = Type.Object({ value: Type.Number() }, { additionalProperties: false });
const TOOL_USAGE: Usage = {
  input: 0,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const TOOL_PROMPT = "必须调用 demo_echo 一次，value 为 10。收到工具结果后直接回答，不要再次调用。";
const BATCH_PROMPT =
  "在同一条助手响应中调用 demo_echo 两次，第一次 value 为 10，第二次 value 为 20。必须同时返回这两个调用，不要等第一个结果。收到结果后直接回答，不要再次调用。";

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}

function textResult(value: number): AgentToolResult<{ value: number }> {
  return {
    content: [{ type: "text", text: `本地计算结果 ${value}。` }],
    details: { value },
    structuredContent: { value },
    usage: TOOL_USAGE,
  };
}

function assertSuccessfulResponse(messages: AgentMessage[]): void {
  const last = messages.at(-1);
  ok(last?.role === "assistant", "没有完整的助手响应。");
  ok(
    last.stopReason === "stop" || last.stopReason === "toolUse",
    `助手异常结束：${last.stopReason}；${last.errorMessage ?? ""}`,
  );
}

/**
 * 将循环推理级别映射到协议原生选项，保留配置中的原生字段。
 * @param config - 已加载的模型配置。
 * @param model - 本次实际使用的模型。
 * @param context - 本次实际发送的上下文。
 * @param options - 循环传入的请求选项。
 * @returns 具有原生推理配置的请求选项。
 */
function nativeOptions(
  config: ResolvedAiConfig,
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
): ApiStreamOptions<Api> {
  const result = {
    ...config.options,
    signal: options?.signal,
    maxRetries: 0,
  } as ApiStreamOptions<Api>;
  const level = options?.reasoning;
  if (!level) {
    return result;
  }
  if (model.api !== "anthropic-messages") {
    return Object.assign(result, { reasoningEffort: level });
  }
  Object.assign(result, { thinkingEnabled: true });
  if (
    model.compat &&
    "forceAdaptiveThinking" in model.compat &&
    model.compat.forceAdaptiveThinking
  ) {
    const mapped = model.thinkingLevelMap?.[level];
    const effort = typeof mapped === "string" ? mapped : level === "minimal" ? "low" : level;
    return Object.assign(result, { effort });
  }
  const modelLimit = model.maxTokens ?? config.options.maxTokens;
  ok(modelLimit !== undefined, "预算思考缺少输出预算。");
  const adjusted = adjustMaxTokensForThinking(
    config.options.maxTokens,
    modelLimit,
    level,
    config.options.thinkingBudgets,
  );
  const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
  const thinkingBudgetTokens = clampThinkingBudgetToAnswerRoom(adjusted.thinkingBudget, maxTokens);
  return Object.assign(result, { maxTokens, thinkingBudgetTokens });
}

function forcedTool(api: Api, name: string): ApiStreamOptions<Api>["toolChoice"] {
  if (api === "anthropic-messages") {
    return { type: "tool", name };
  }
  if (api === "openai-completions") {
    return { type: "function", function: { name } };
  }
  return { type: "function", name };
}

/**
 * 创建具有时间和请求上限的场景运行环境，场景自行配置专属行为。
 * @param config - 当前模型及原生请求配置。
 * @param signal - 用户取消整个演示的信号。
 * @returns 包含上下文、事件记录和真实协议传输的运行环境。
 * @remarks 每个场景最多四次请求、限时六十秒且不自动重试。
 */
function createDemoRun(config: ResolvedAiConfig, signal: AbortSignal): DemoRun {
  const trace: Trace = {
    requests: 0,
    events: [],
    order: [],
    starts: [],
    ends: [],
    active: 0,
    maxActive: 0,
    prepared: 0,
    nested: 0,
    before: 0,
    after: 0,
    sawSteering: false,
    sawFollowUp: false,
    toolSets: [],
  };
  const cancellation = new AbortController();
  const context: AgentContext = {
    messages: [
      {
        role: "system",
        content: "进行代理循环演示。严格遵守工具调用指令，结果返回后用一句中文回答，不再调用工具。",
        timestamp: Date.now(),
      },
    ],
    tools: [],
  };
  const loopConfig: AgentLoopConfig = {
    model: config.model,
    apiKey: config.options.apiKey,
    reasoning: config.options.reasoning,
    toolExecution: "parallel",
    /**
     * 返回本包使用的模型消息。
     * @param messages - 当前代理消息。
     * @returns 保持原样的模型消息。
     */
    convertToLlm: (messages: AgentMessage[]): Message[] => messages,
  };
  const run: DemoRun = {
    trace,
    context,
    activeContext: context,
    loopConfig,
    cancellation,
    signal: AbortSignal.any([signal, cancellation.signal, AbortSignal.timeout(60_000)]),
    forceTools: new Map(),
    /**
     * 保存代理循环发出的事件。
     * @param event - 当前事件。
     */
    emit: (event: AgentEvent): void => {
      trace.events.push(event);
    },
    /**
     * 通过配置中的真实协议发送请求，并限制最大请求次数。
     * @param model - 当前模型。
     * @param transcript - 当前规范化上下文。
     * @param options - 当前循环请求选项。
     * @returns 真实适配器事件流，超过请求上限时返回错误事件流。
     */
    streamFn: (
      model: Model<Api>,
      transcript: TranscriptContext,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream => {
      if (trace.requests >= 4) {
        const response = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          model: model.id,
          baseUrl: model.baseUrl,
          content: [],
          usage: TOOL_USAGE,
          stopReason: "error",
          errorMessage: "场景超过 4 次请求上限。",
          timestamp: Date.now(),
        };
        response.push({ type: "error", reason: "error", error: message });
        response.end(message);
        return response;
      }
      trace.requests++;
      trace.order.push("stream");
      run.inspectTranscript?.(transcript);
      const declarations = getCurrentTools(transcript.messages);
      trace.toolSets.push(declarations.map((tool: { name: string }): string => tool.name));
      const request = nativeOptions(config, model, transcript, options);
      const name = run.forceTools.get(trace.requests);
      request.toolChoice = name ? forcedTool(model.api, name) : "auto";
      return stream(model, transcript, request);
    },
  };
  return run;
}

/**
 * 创建只在内存中执行的工具，共用参数准备、更新和并发记录。
 * @param trace - 当前场景的行为记录。
 * @param name - 模型可见的精确工具名。
 * @param execute - 场景专属执行逻辑，省略时回显已准备的值。
 * @returns 可供代理循环执行的工具。
 */
function memoryTool(
  trace: Trace,
  name: string = "demo_echo",
  execute?: DemoTool["execute"],
): DemoTool {
  return {
    name,
    label: "内存计算",
    description: "本地计算并回显 value。每个调用必须提供数字 value。",
    parameters: PARAMETERS,
    /**
     * 在模式校验前将数字参数增加一。
     * @param args - 模型生成的原始参数。
     * @returns 已准备参数，异常输入保持原值交由模式校验。
     */
    prepareArguments: (args: unknown): { value: number } => {
      trace.prepared++;
      const value = (args as { value?: unknown } | null)?.value;
      if (typeof value !== "number") {
        return args as { value: number };
      }
      return { value: value + 1 };
    },
    /**
     * 报告部分结果并记录真实执行顺序，随后执行场景专属逻辑。
     * @param toolCallId - 当前调用标识。
     * @param params - 已准备且校验的参数。
     * @param signal - 当前运行的取消信号。
     * @param onUpdate - 部分结果回调。
     * @returns 场景逻辑或内存回显产生的最终结果。
     * @throws 场景逻辑抛错或执行被取消时拒绝。
     */
    execute: async (
      toolCallId: string,
      params: { value: number },
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<{ value: number }>,
    ): Promise<AgentToolResult<{ value: number }>> => {
      trace.starts.push(toolCallId);
      trace.active++;
      trace.maxActive = Math.max(trace.maxActive, trace.active);
      try {
        onUpdate?.(textResult(params.value));
        await delay(trace.starts.length === 1 ? 100 : 5, undefined, { signal });
        if (execute) {
          return await execute(toolCallId, params, signal, onUpdate);
        }
        return textResult(params.value);
      } finally {
        trace.active--;
        trace.ends.push(toolCallId);
      }
    },
  };
}

function checkPreparedArguments(trace: Trace, call: BeforeToolCallContext): void {
  trace.before++;
  const original = call.toolCall.arguments.value;
  ok(typeof original === "number", "原始工具参数不是数字。");
  const prepared = call.args as { value: number };
  strictEqual(prepared.value, original + 1, "参数准备未在模式校验前生效。");
}

function useTool(run: DemoRun, tool: DemoTool): void {
  run.context.tools = [tool];
  run.forceTools.set(1, tool.name);
}

function responseMessages(
  run: DemoRun,
  messages: AgentMessage[],
): {
  assistants: AssistantMessage[];
  results: Extract<AgentMessage, { role: "toolResult" }>[];
} {
  strictEqual(run.trace.events.at(-1)?.type, "agent_end", "缺少正常结束事件。");
  const assistants = messages.filter(
    (message: AgentMessage): message is AssistantMessage => message.role === "assistant",
  );
  const results = messages.filter(
    (message: AgentMessage): message is Extract<AgentMessage, { role: "toolResult" }> =>
      message.role === "toolResult",
  );
  ok(assistants.length > 0, "没有助手响应。");
  return { assistants, results };
}

function checkResponse(run: DemoRun, messages: AgentMessage[]): void {
  const { assistants, results } = responseMessages(run, messages);
  for (const assistant of assistants) {
    assertSuccessfulResponse([assistant]);
  }
  const trace = run.trace;
  ok(
    trace.events.some((event: AgentEvent): boolean => event.type === "message_update"),
    "未观察到流式更新。",
  );
  if (run.forceTools.size > 0) {
    ok(results.length > 0, "要求工具调用但没有工具结果。");
    ok(trace.prepared > 0, "工具参数准备未触发。");
  }
}

function checkBatch(run: DemoRun, messages: AgentMessage[], maxActive: number): void {
  const { assistants, results } = responseMessages(run, messages);
  const calls =
    assistants[0]?.content.filter(
      (block: AssistantMessage["content"][number]): block is AgentToolCall =>
        block.type === "toolCall",
    ) ?? [];
  strictEqual(calls.length, 2, "必须由模型在同一条助手消息中返回两个工具调用。");
  const resultIds = results.map(
    (message: Extract<AgentMessage, { role: "toolResult" }>): string => message.toolCallId,
  );
  deepStrictEqual(
    resultIds,
    calls.map((call: AgentToolCall): string => call.id),
  );
  strictEqual(run.trace.maxActive, maxActive);
  const endIds = run.trace.events
    .filter(
      (event: AgentEvent): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end",
    )
    .map((event: Extract<AgentEvent, { type: "tool_execution_end" }>): string => event.toolCallId);
  deepStrictEqual(endIds, run.trace.ends);
}

function reportScenario(name: string, run: DemoRun, messages: AgentMessage[]): void {
  const { assistants, results } = responseMessages(run, messages);
  console.log(
    `agent-loop / ${name}：请求 ${run.trace.requests}，轮次 ${assistants.length}，工具结果 ${results.length}，事件 ${run.trace.events.length}。`,
  );
}

async function runPrompt(
  run: DemoRun,
  prompt: Message = userMessage("只回复一句中文问候。"),
): Promise<AgentMessage[]> {
  const messages = await runAgentLoop(
    [prompt],
    run.context,
    run.loopConfig,
    run.emit,
    run.signal,
    run.streamFn,
  );
  checkResponse(run, messages);
  return messages;
}

// 验证直接入口及已有上下文的继续运行。
async function demoEntryAndContinue(config: ResolvedAiConfig, signal: AbortSignal): Promise<void> {
  const run = createDemoRun(config, signal);
  const messages = await runPrompt(run);
  const continuation = {
    ...run.context,
    messages: [...run.context.messages, ...messages, userMessage("请回复继续完成。")],
  };
  const more = await runAgentLoopContinue(
    continuation,
    run.loopConfig,
    run.emit,
    run.signal,
    run.streamFn,
  );
  messages.push(...more);
  checkResponse(run, messages);
  strictEqual(run.trace.requests, 2);
  reportScenario("入口与继续", run, messages);
}

// 验证事件流入口及事件流续跑。
async function demoEventStream(config: ResolvedAiConfig, signal: AbortSignal): Promise<void> {
  const run = createDemoRun(config, signal);
  const events = agentLoop(
    [userMessage("只回复一句中文问候。")],
    run.context,
    run.loopConfig,
    run.signal,
    run.streamFn,
  );
  for await (const event of events) {
    run.emit(event);
  }
  const messages = await events.result();
  checkResponse(run, messages);
  const continuation = {
    ...run.context,
    messages: [...run.context.messages, ...messages, userMessage("请回复事件流继续完成。")],
  };
  const continued = agentLoopContinue(continuation, run.loopConfig, run.signal, run.streamFn);
  for await (const event of continued) {
    run.emit(event);
  }
  messages.push(...(await continued.result()));
  checkResponse(run, messages);
  strictEqual(run.trace.requests, 2);
  reportScenario("事件流入口", run, messages);
}

// 验证循环配置要求同批工具串行执行。
async function demoSequentialTools(config: ResolvedAiConfig, signal: AbortSignal): Promise<void> {
  const run = createDemoRun(config, signal);
  run.loopConfig.toolExecution = "sequential";
  useTool(run, memoryTool(run.trace));
  const messages = await runPrompt(run, userMessage(BATCH_PROMPT));
  checkBatch(run, messages, 1);
  reportScenario("串行工具", run, messages);
}

// 验证同批工具并行执行及完成事件与结果消息的不同排序。
async function demoParallelTools(config: ResolvedAiConfig, signal: AbortSignal): Promise<void> {
  const run = createDemoRun(config, signal);
  useTool(run, memoryTool(run.trace));
  const messages = await runPrompt(run, userMessage(BATCH_PROMPT));
  checkBatch(run, messages, 2);
  deepStrictEqual(run.trace.ends, [...run.trace.starts].reverse());
  reportScenario("并行工具", run, messages);
}

// 验证工具声明可以要求整批串行执行。
async function demoToolRequiresSequential(
  config: ResolvedAiConfig,
  signal: AbortSignal,
): Promise<void> {
  const run = createDemoRun(config, signal);
  const tool = memoryTool(run.trace);
  tool.executionMode = "sequential";
  useTool(run, tool);
  const messages = await runPrompt(run, userMessage(BATCH_PROMPT));
  checkBatch(run, messages, 1);
  reportScenario("工具要求整批串行", run, messages);
}

/**
 * 验证参数准备、部分更新、结果覆盖及共享钩子的嵌套调用。
 * @param config - 当前模型配置。
 * @param signal - 整个演示的取消信号。
 * @returns 嵌套执行及所有结果覆盖断言完成。
 */
async function demoToolHooksAndNested(
  config: ResolvedAiConfig,
  signal: AbortSignal,
): Promise<void> {
  const run = createDemoRun(config, signal);
  const tool = memoryTool(
    run.trace,
    "demo_echo",
    async (
      toolCallId: string,
      params: { value: number },
      toolSignal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<{ value: number }>,
    ): Promise<AgentToolResult<{ value: number }>> => {
      const context = run.activeContext;
      const assistant = context.messages.findLast(
        (message: AgentMessage): message is AssistantMessage => message.role === "assistant",
      );
      ok(assistant, "嵌套调用缺少发起消息。");
      const nested = memoryTool(run.trace, "nested_echo");
      const outcome = await runToolCall(
        { type: "toolCall", id: `${toolCallId}_nested`, name: nested.name, arguments: params },
        {
          tools: [nested],
          beforeToolCall: run.loopConfig.beforeToolCall,
          afterToolCall: run.loopConfig.afterToolCall,
          assistantMessage: assistant,
          context,
          signal: toolSignal,
          onUpdate,
        },
      );
      strictEqual(outcome.isError, false);
      run.trace.nested++;
      return textResult(params.value);
    },
  );
  useTool(run, tool);
  /**
   * 在内外两次执行前核对参数准备并保存工具上下文。
   * @param call - 当前已校验的工具调用。
   * @returns 参数检查完成，不阻止执行。
   */
  run.loopConfig.beforeToolCall = async (call: BeforeToolCallContext): Promise<undefined> => {
    checkPreparedArguments(run.trace, call);
    run.activeContext = call.context;
    return undefined;
  };
  /**
   * 覆盖内外两次工具执行的结果字段。
   * @param call - 原执行结果与调用上下文。
   * @returns 需要替换的内容、详情、用量和控制字段。
   */
  run.loopConfig.afterToolCall = async (
    call: AfterToolCallContext,
  ): Promise<AfterToolCallResult> => {
    run.trace.after++;
    ok(call.result.structuredContent, "工具未产生结构化结果。");
    return {
      content: [{ type: "text", text: "钩子覆盖后的结果 99。" }],
      details: { value: 99 },
      structuredContent: { value: 99 },
      usage: TOOL_USAGE,
      isError: false,
      terminate: false,
    };
  };
  const messages = await runPrompt(run, userMessage(TOOL_PROMPT));
  strictEqual(run.trace.nested, 1);
  strictEqual(run.trace.before, 2);
  strictEqual(run.trace.after, 2);
  ok(run.trace.events.some((event: AgentEvent): boolean => event.type === "tool_execution_update"));
  const event = run.trace.events.find(
    (item: AgentEvent): item is Extract<AgentEvent, { type: "tool_execution_end" }> =>
      item.type === "tool_execution_end",
  );
  ok(event);
  deepStrictEqual(event.result.structuredContent, { value: 99 });
  deepStrictEqual(event.result.details, { value: 99 });
  deepStrictEqual(event.result.usage, TOOL_USAGE);
  deepStrictEqual(event.result.content, [{ type: "text", text: "钩子覆盖后的结果 99。" }]);
  reportScenario("参数与结果钩子及嵌套", run, messages);
}

// 验证调用前阻止执行并提前结束循环。
async function demoBlockAndTerminate(config: ResolvedAiConfig, signal: AbortSignal): Promise<void> {
  const run = createDemoRun(config, signal);
  useTool(run, memoryTool(run.trace));
  /**
   * 完成公共参数检查后阻止工具执行。
   * @param call - 当前已校验的调用。
   * @returns 要求错误回填和提前终止的阻止结果。
   */
  run.loopConfig.beforeToolCall = async (
    call: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult> => {
    checkPreparedArguments(run.trace, call);
    return { block: true, reason: "本地演示阻止执行。", terminate: true };
  };
  const messages = await runPrompt(run, userMessage(TOOL_PROMPT));
  strictEqual(run.trace.starts.length, 0);
  strictEqual(run.trace.requests, 1);
  strictEqual(run.trace.after, 0);
  const { results } = responseMessages(run, messages);
  ok(
    results.every(
      (message: Extract<AgentMessage, { role: "toolResult" }>): boolean => message.isError,
    ),
    "错误没有回填。",
  );
  reportScenario("阻止并终止", run, messages);
}

// 验证抛错与主动错误结果均回填给模型并允许继续。
async function demoToolErrorRecovery(config: ResolvedAiConfig, signal: AbortSignal): Promise<void> {
  const run = createDemoRun(config, signal);
  run.loopConfig.toolExecution = "sequential";
  const tool = memoryTool(
    run.trace,
    "demo_echo",
    async (
      _toolCallId: string,
      params: { value: number },
    ): Promise<AgentToolResult<{ value: number }>> => {
      if (run.trace.starts.length === 1) {
        throw new Error("内存工具主动抛错，请直接说明失败，不要重试。");
      }
      return { ...textResult(params.value), isError: true };
    },
  );
  useTool(run, tool);
  const messages = await runPrompt(run, userMessage(BATCH_PROMPT));
  checkBatch(run, messages, 1);
  const { results } = responseMessages(run, messages);
  ok(
    results.every(
      (message: Extract<AgentMessage, { role: "toolResult" }>): boolean => message.isError,
    ),
    "错误没有回填。",
  );
  reportScenario("工具错误恢复", run, messages);
}

// 验证同批所有工具返回终止标记时不再请求模型。
async function demoAllToolsTerminate(config: ResolvedAiConfig, signal: AbortSignal): Promise<void> {
  const run = createDemoRun(config, signal);
  const tool = memoryTool(
    run.trace,
    "demo_echo",
    async (
      _toolCallId: string,
      params: { value: number },
    ): Promise<AgentToolResult<{ value: number }>> => ({
      ...textResult(params.value),
      terminate: true,
    }),
  );
  useTool(run, tool);
  const messages = await runPrompt(run, userMessage(BATCH_PROMPT));
  checkBatch(run, messages, 2);
  strictEqual(run.trace.requests, 1);
  reportScenario("全部工具终止", run, messages);
}

/**
 * 验证请求状态替换、上下文变换、模型消息过滤和轮次调度。
 * @param config - 当前模型配置。
 * @param signal - 整个演示的取消信号。
 * @returns 请求顺序、临时消息隔离及继续一次后结束的断言完成。
 */
async function demoRequestAndTurnScheduling(
  config: ResolvedAiConfig,
  signal: AbortSignal,
): Promise<void> {
  const run = createDemoRun(config, signal);
  /**
   * 替换实际请求上下文并追加持久系统消息。
   * @param request - 当前请求状态。
   * @returns 模型、上下文和推理级别的完整替换值。
   */
  run.loopConfig.prepareRequest = (request: PrepareRequestContext): AgentRequestUpdate => {
    run.trace.order.push("prepareRequest");
    run.activeContext = {
      ...request.context,
      messages: [
        ...request.context.messages,
        { role: "system", content: "请求准备：使用中文回复。", timestamp: Date.now() },
      ],
    };
    return {
      context: run.activeContext,
      model: request.model,
      thinkingLevel: request.thinkingLevel,
    };
  };
  /**
   * 在独立消息数组中注入临时系统消息。
   * @param messages - 当前代理消息。
   * @returns 带临时标记的消息数组。
   */
  run.loopConfig.transformContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    run.trace.order.push("transformContext");
    return [...messages, { role: "system", content: "转换前临时标记。", timestamp: Date.now() }];
  };
  /**
   * 验证变换已经执行并过滤不发送给模型的临时消息。
   * @param messages - 变换后的代理消息。
   * @returns 已过滤的模型消息。
   */
  run.loopConfig.convertToLlm = (messages: AgentMessage[]): Message[] => {
    run.trace.order.push("convertToLlm");
    ok(
      messages.some(
        (message: AgentMessage): boolean =>
          message.role === "system" && message.content === "转换前临时标记。",
      ),
      "上下文变换未注入临时消息。",
    );
    return messages.filter(
      (message: AgentMessage): boolean =>
        message.role !== "system" || message.content !== "转换前临时标记。",
    );
  };
  /**
   * 强制继续一轮后停止。
   * @param turn - 当前已完成轮次。
   * @returns 下一轮继续或立即结束的调度决定。
   */
  run.loopConfig.finishTurn = (turn: AgentTurnContext): AgentTurnDecision => {
    run.trace.order.push("finishTurn");
    ok(turn.newMessages.includes(turn.message), "轮次消息未进入新增消息。");
    return { action: run.trace.requests === 1 ? "continue" : "end" };
  };
  /**
   * 为被强制继续的下一轮追加用户消息。
   * @returns 新消息及下一轮模型。
   */
  run.loopConfig.prepareNextTurn = (): AgentLoopTurnUpdate => {
    run.trace.order.push("prepareNextTurn");
    return { messages: [userMessage("请回复：调度已继续。")], model: config.model };
  };
  /**
   * 验证实际发送内容与持久上下文的隔离。
   * @param transcript - 模型接收的消息。
   */
  run.inspectTranscript = (transcript: TranscriptContext): void => {
    ok(
      transcript.messages.some(
        (message: Message): boolean =>
          message.role === "system" && message.content === "请求准备：使用中文回复。",
      ),
      "prepareRequest 替换未传入模型。",
    );
    ok(
      !transcript.messages.some(
        (message: Message): boolean =>
          message.role === "system" && message.content === "转换前临时标记。",
      ),
      "convertToLlm 未过滤临时消息。",
    );
    ok(
      !run.activeContext.messages.some(
        (message: AgentMessage): boolean =>
          message.role === "system" && message.content === "转换前临时标记。",
      ),
      "临时上下文变换污染原上下文。",
    );
  };
  const messages = await runPrompt(run);
  const starts = run.trace.order.filter((step: string): boolean =>
    ["prepareRequest", "transformContext", "convertToLlm", "stream"].includes(step),
  );
  for (let index = 0; index < run.trace.requests; index++) {
    deepStrictEqual(starts.slice(index * 4, index * 4 + 4), [
      "prepareRequest",
      "transformContext",
      "convertToLlm",
      "stream",
    ]);
  }
  strictEqual(run.trace.requests, 2);
  strictEqual(
    run.trace.order.filter((step: string): boolean => step === "prepareNextTurn").length,
    1,
  );
  ok(
    messages.some(
      (message: AgentMessage): boolean =>
        message.role === "user" && message.content === "请回复：调度已继续。",
    ),
  );
  reportScenario("请求与轮次调度", run, messages);
}

// 验证工具完成后的引导消息及自然停止后的后续消息。
async function demoSteeringAndFollowUp(
  config: ResolvedAiConfig,
  signal: AbortSignal,
): Promise<void> {
  const run = createDemoRun(config, signal);
  useTool(run, memoryTool(run.trace));
  /**
   * 在工具执行完成后注入一次引导消息。
   * @returns 待注入消息，未到注入时机或已经注入时返回空数组。
   */
  run.loopConfig.getSteeringMessages = async (): Promise<AgentMessage[]> => {
    if (run.trace.sawSteering || run.trace.ends.length === 0) {
      return [];
    }
    run.trace.sawSteering = true;
    return [userMessage("引导消息：直接解释结果，不再调用工具。")];
  };
  /**
   * 自然停止后注入一次后续消息。
   * @returns 待注入消息，未到注入时机或已经注入时返回空数组。
   */
  run.loopConfig.getFollowUpMessages = async (): Promise<AgentMessage[]> => {
    if (run.trace.sawFollowUp || !run.trace.sawSteering) {
      return [];
    }
    run.trace.sawFollowUp = true;
    return [userMessage("后续消息：请回复演示完成，不再使用工具。")];
  };
  const messages = await runPrompt(run, userMessage(TOOL_PROMPT));
  ok(run.trace.sawSteering && run.trace.sawFollowUp);
  strictEqual(run.trace.requests, 3);
  const steeringIndex = messages.findIndex(
    (message: AgentMessage): boolean =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith("引导消息："),
  );
  const resultIndex = messages.findIndex(
    (message: AgentMessage): boolean => message.role === "toolResult",
  );
  ok(steeringIndex > resultIndex, "引导消息早于工具结果。");
  reportScenario("引导与后续消息", run, messages);
}

// 验证下一轮替换可执行工具及历史声明差量同步。
async function demoDynamicTools(config: ResolvedAiConfig, signal: AbortSignal): Promise<void> {
  const run = createDemoRun(config, signal);
  useTool(run, memoryTool(run.trace));
  run.forceTools.set(2, "replacement_echo");
  /**
   * 在首轮工具结束后替换工具并追加新指令。
   * @param turn - 上一轮执行完成后的上下文。
   * @returns 首轮后返回替换状态，其余轮次保持默认行为。
   */
  run.loopConfig.prepareNextTurn = (turn: AgentTurnContext): AgentLoopTurnUpdate | undefined => {
    run.trace.order.push("prepareNextTurn");
    if (run.trace.requests !== 1) {
      return undefined;
    }
    const tool = memoryTool(run.trace, "replacement_echo");
    return {
      context: { ...turn.context, tools: [tool] },
      messages: [
        userMessage("现在调用 replacement_echo 一次，value 为 30，然后直接回答。原工具已移除。"),
      ],
    };
  };
  const messages = await runPrompt(run, userMessage(TOOL_PROMPT));
  deepStrictEqual(run.trace.toolSets, [["demo_echo"], ["replacement_echo"], ["replacement_echo"]]);
  const delta = messages.find(
    (message: AgentMessage): boolean =>
      message.role === "system" &&
      message.toolsRemoved?.some((tool: { name: string }): boolean => tool.name === "demo_echo") ===
        true,
  );
  ok(delta && delta.role === "system");
  deepStrictEqual(delta.toolsRemoved, [{ name: "demo_echo" }]);
  deepStrictEqual(
    delta.toolsAdded?.map((tool: { name: string }): string => tool.name),
    ["replacement_echo"],
  );
  reportScenario("工具动态替换", run, messages);
}

// 验证收到原生响应事件后取消模型请求。
async function demoAbortDuringResponse(
  config: ResolvedAiConfig,
  signal: AbortSignal,
): Promise<void> {
  const scenarioConfig = { ...config, options: { ...config.options } };
  const run = createDemoRun(scenarioConfig, signal);
  const original = config.options.onStreamEvent;
  /**
   * 收到真实协议事件后取消当前请求。
   * @param event - 原生响应事件。
   * @param eventModel - 事件使用的模型。
   * @returns 原观察回调和取消操作完成。
   */
  scenarioConfig.options.onStreamEvent = async (
    event: unknown,
    eventModel: Model,
  ): Promise<void> => {
    await original?.(event, eventModel);
    run.cancellation.abort();
  };
  const messages = await runAgentLoop(
    [userMessage("只回复一句中文问候。")],
    run.context,
    run.loopConfig,
    run.emit,
    run.signal,
    run.streamFn,
  );
  const { assistants } = responseMessages(run, messages);
  ok(run.cancellation.signal.aborted, "未在响应过程中执行取消。");
  strictEqual(assistants.at(-1)?.stopReason, "aborted");
  console.log(`agent-loop / 响应中取消：请求 ${run.trace.requests}，已收到 aborted 结束事件。`);
}

/**
 * 验证图片输入通过代理循环发送给模型。
 * @param config - 已声明图片输入能力的模型配置。
 * @param signal - 整个演示的取消信号。
 * @param image - 已校验的演示图片。
 * @returns 图片请求和正常结束断言完成。
 * @throws 未提供图片时抛出错误。
 */
async function demoImageInput(
  config: ResolvedAiConfig,
  signal: AbortSignal,
  image: ImageContent | undefined,
): Promise<void> {
  ok(image, "模型已声明图片能力，但未提供演示图片。");
  const run = createDemoRun(config, signal);
  const prompt: Message = {
    role: "user",
    content: [{ type: "text", text: "简短描述图片。" }, image],
    timestamp: Date.now(),
  };
  const messages = await runPrompt(run, prompt);
  reportScenario("图片输入", run, messages);
}

/**
 * 用需要计算的问题验证推理请求和响应中的推理证据。
 * @param config - 已声明推理能力的模型及请求配置。
 * @param signal - 整个演示的取消信号。
 * @returns 推理级别记录及思考内容或推理用量断言通过后完成。
 * @throws 响应既没有思考块也没有正数推理用量时抛出错误。
 * @remarks 优先使用已声明支持的 high；不要求服务每次都公开思考内容。
 */
async function demoReasoning(config: ResolvedAiConfig, signal: AbortSignal): Promise<void> {
  const run = createDemoRun(config, signal);
  const levels = getSupportedThinkingLevels(config.model);
  run.loopConfig.reasoning = levels.includes("high")
    ? "high"
    : levels.find(
        (level: string): level is NonNullable<SimpleStreamOptions["reasoning"]> => level !== "off",
      );
  const prompt = userMessage(
    "求最小正整数 n，使 n 除以 7 余 3、除以 11 余 5、除以 13 余 7。请给出答案并简要核验三个余数。",
  );
  const messages = await runPrompt(run, prompt);
  const { assistants } = responseMessages(run, messages);
  const response = assistants[0];
  ok(response?.thinkingLevel && response.thinkingLevel !== "off");
  const hasThinkingContent = response.content.some(
    (block: AssistantMessage["content"][number]): boolean => block.type === "thinking",
  );
  const reasoningTokens = response.usage.reasoning ?? 0;
  ok(hasThinkingContent || reasoningTokens > 0, "模型既未返回思考内容，也未报告有效推理用量。");
  console.log(
    `推理证据：级别 ${response.thinkingLevel}，推理 token ${reasoningTokens}，思考块 ${hasThinkingContent ? "有" : "无"}。`,
  );
  reportScenario("推理请求", run, messages);
}

/** 代理循环演示完成后的场景统计。 */
export interface DemoSummary {
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * 加载配置并依次调用代理循环各场景，汇总结果并处理用户中断。
 * @param directory - settings.json、.env 和演示图片所在目录，默认使用当前工作目录。
 * @param fetch - 可选请求传输；离线测试传入替身，真实运行使用默认传输。
 * @returns 每个代理场景的成功、失败和跳过数量。
 * @throws 配置无效、声明图片能力但图片无效或用户中断时拒绝。
 * @remarks 只有声明图片输入能力时读取 docs/logo.jpg；工具仅在内存中计算，不执行外部命令。
 */
export async function main(
  directory: string = process.cwd(),
  fetch?: FetchFunction,
): Promise<DemoSummary> {
  const config = await loadAiConfig(directory);
  if (fetch) {
    config.options = { ...config.options, fetch };
  }
  let image: ImageContent | undefined;
  if (config.model.input?.includes("image")) {
    const bytes = await readFile(resolve(directory, "docs", "logo.jpg"));
    const signature = bytes.subarray(0, 3).toString("hex");
    if (signature !== "ffd8ff") {
      throw new Error("docs/logo.jpg 必须是 JPEG 图片。");
    }
    image = { type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" };
  }
  const controller = new AbortController();
  const signal = controller.signal;
  const summary: DemoSummary = { passed: 0, failed: 0, skipped: 0 };
  /** 将用户中断转为模型请求和工具执行共享的取消信号。 */
  const interrupt = (): void => {
    controller.abort();
  };
  /**
   * 统计单个场景结果并隐藏失败消息中的密钥。
   * @param name - 输出使用的中文场景名。
   * @param execute - 场景自己的演示方法。
   * @param shouldSkip - 模型未声明能力时跳过该场景。
   * @returns 本场景结束或跳过后完成。
   * @throws 用户中断整个演示时拒绝。
   */
  const runScene = async (
    name: string,
    execute: () => Promise<void>,
    shouldSkip: boolean = false,
  ): Promise<void> => {
    if (signal.aborted) {
      throw new Error("代理循环演示已中断。");
    }
    if (shouldSkip) {
      summary.skipped++;
      console.log(`agent-loop / ${name}：跳过，模型未声明对应能力。`);
      return;
    }
    try {
      await execute();
      summary.passed++;
    } catch (error: unknown) {
      if (signal.aborted) {
        throw new Error("代理循环演示已中断。");
      }
      summary.failed++;
      const message = error instanceof Error ? error.message : "未知失败";
      const visible = message.split(config.options.apiKey).join("[密钥已隐藏]");
      console.error(`agent-loop / ${name}：失败，${visible}`);
    }
  };
  process.once("SIGINT", interrupt);
  try {
    await runScene("入口与继续", (): Promise<void> => demoEntryAndContinue(config, signal));
    await runScene("事件流入口", (): Promise<void> => demoEventStream(config, signal));
    await runScene("串行工具", (): Promise<void> => demoSequentialTools(config, signal));
    await runScene("并行工具", (): Promise<void> => demoParallelTools(config, signal));
    await runScene("工具要求整批串行", (): Promise<void> =>
      demoToolRequiresSequential(config, signal),
    );
    await runScene("参数与结果钩子及嵌套", (): Promise<void> =>
      demoToolHooksAndNested(config, signal),
    );
    await runScene("阻止并终止", (): Promise<void> => demoBlockAndTerminate(config, signal));
    await runScene("工具错误恢复", (): Promise<void> => demoToolErrorRecovery(config, signal));
    await runScene("全部工具终止", (): Promise<void> => demoAllToolsTerminate(config, signal));
    await runScene("请求与轮次调度", (): Promise<void> =>
      demoRequestAndTurnScheduling(config, signal),
    );
    await runScene("引导与后续消息", (): Promise<void> => demoSteeringAndFollowUp(config, signal));
    await runScene("工具动态替换", (): Promise<void> => demoDynamicTools(config, signal));
    await runScene("响应中取消", (): Promise<void> => demoAbortDuringResponse(config, signal));
    await runScene(
      "图片输入",
      (): Promise<void> => demoImageInput(config, signal, image),
      !config.model.input?.includes("image"),
    );
    await runScene(
      "推理请求",
      (): Promise<void> => demoReasoning(config, signal),
      config.model.reasoning !== true,
    );
    console.log(
      `代理演示完成：成功 ${summary.passed}，失败 ${summary.failed}，跳过 ${summary.skipped}。`,
    );
    return summary;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

const ENTRY_PATH = process.argv[1] ? resolve(process.argv[1]) : undefined;
const IS_DIRECT_RUN =
  ENTRY_PATH !== undefined && import.meta.url === pathToFileURL(ENTRY_PATH).href;
if (IS_DIRECT_RUN) {
  const execution = main();
  void execution
    .then((summary: DemoSummary): void => {
      if (summary.failed > 0) {
        process.exitCode = 1;
      }
    })
    .catch((error: unknown): void => {
      console.error("运行失败：", error instanceof Error ? error.message : "未知错误");
      process.exitCode = 1;
    });
}

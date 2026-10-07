import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Type,
  complete,
  completeSimple,
  stream,
  streamSimple,
  getSupportedThinkingLevels,
  validateToolCall,
  contentText,
  normalizeContext,
  type ApiStreamOptions,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type FetchFunction,
  type ImageContent,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "./llm-api/index.ts";
import { loadAiConfig, type ResolvedAiConfig } from "./config/index.ts";
import {
  adjustMaxTokensForThinking,
  clampMaxTokensToContext,
  clampThinkingBudgetToAnswerRoom,
} from "./llm-api/api/simple-options.ts";

const MAX_TOOL_ROUNDS = 4;
const METHODS = ["stream", "complete", "streamSimple", "completeSimple"] as const;
type Method = (typeof METHODS)[number];

/** 演示完成后的场景统计，每个场景与调用入口分别计数。 */
export interface DemoSummary {
  passed: number;
  failed: number;
  skipped: number;
}

interface Scenario {
  name: string;
  prompt: string;
  images?: ImageContent[];
  imageOnly?: boolean;
  tools?: Tool[];
  followUp?: string;
  updateSystem?: boolean;
  dynamicTools?: boolean;
  disableTools?: boolean;
  requireTool?: boolean;
  reasoning?: SimpleStreamOptions["reasoning"];
  skipReason?: string;
}

const ADD_TOOL: Tool = {
  name: "add_numbers",
  description: "计算两个数字的和。",
  parameters: Type.Object({ a: Type.Number(), b: Type.Number() }, { additionalProperties: false }),
};
const IMAGE_TOOL: Tool = {
  name: "get_demo_image",
  description: "读取本地演示图片。",
  parameters: Type.Object({}, { additionalProperties: false }),
};
const ERROR_TOOL: Tool = {
  name: "fail_demo",
  description: "返回演示用的工具执行错误。",
  parameters: Type.Object({}, { additionalProperties: false }),
};
const ECHO_TOOL: Tool = {
  name: "echo_text",
  description: "原样返回给定的文本。",
  parameters: Type.Object({ input: Type.String() }, { additionalProperties: false }),
};

function redact(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[密钥已隐藏]") : message;
}

function userMessage(content: string | ImageContent[], prompt?: string): Message {
  if (typeof content === "string") {
    return { role: "user", content, timestamp: Date.now() };
  }
  return {
    role: "user",
    content: [{ type: "text", text: prompt ?? "描述图片。" }, ...content],
    timestamp: Date.now(),
  };
}

/**
 * 消费流式事件并返回最终消息，按内容块分别显示文本、思考和工具参数。
 * @param events - 当前请求的事件流。
 * @param apiKey - 仅用于输出脱敏的密钥。
 * @returns 流完成后的助手消息，包括失败或中断消息。
 */
async function consumeStream(
  events: AssistantMessageEventStream,
  apiKey: string,
): Promise<AssistantMessage> {
  for await (const event of events) {
    if (
      event.type === "text_delta" ||
      event.type === "thinking_delta" ||
      event.type === "toolcall_delta"
    ) {
      console.log(`${event.type}：${redact(event.delta, apiKey)}`);
    }
    if (event.type === "error") {
      console.error(redact(event.error.errorMessage ?? "请求失败", apiKey));
    }
  }
  return await events.result();
}

/**
 * 根据场景构建协议原生工具选择，不改变配置中其他请求选项。
 * @param api - 已确认的端点协议。
 * @param scenario - 本次演示场景。
 * @returns 协议支持的工具选择值；没有工具约束时返回 auto。
 */
function toolChoice(api: Api, scenario: Scenario): ApiStreamOptions<Api>["toolChoice"] {
  if (scenario.disableTools) {
    return "none";
  }
  const tool = scenario.tools?.[0];
  if (!scenario.requireTool || !tool) {
    return "auto";
  }
  if (tool.constrainedSampling && tool.constrainedSampling.type === "grammar") {
    if (api === "openai-completions") {
      return { type: "custom", custom: { name: tool.name } };
    }
    if (api === "openai-responses") {
      return { type: "custom", name: tool.name };
    }
  }
  if (api === "anthropic-messages") {
    return { type: "tool", name: tool.name };
  }
  if (api === "openai-completions") {
    return { type: "function", function: { name: tool.name } };
  }
  return { type: "function", name: tool.name };
}

/**
 * 调用一个公开模型入口，将原生选项和简化选项分开处理。
 * @param method - 要演示的公开调用入口。
 * @param config - 已加载的模型及请求配置。
 * @param context - 当前对话历史。
 * @param scenario - 本次场景的工具及推理约束。
 * @param signal - 请求取消信号。
 * @returns 最终助手消息；请求失败状态保留在消息中。
 */
async function callModel(
  method: Method,
  config: ResolvedAiConfig,
  context: Context,
  scenario: Scenario,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  const options: ApiStreamOptions<Api> = {
    ...config.options,
    signal,
    toolChoice: toolChoice(config.model.api, scenario),
  } as ApiStreamOptions<Api>;
  if (scenario.reasoning) {
    if (config.model.api === "anthropic-messages") {
      const mapped = config.model.thinkingLevelMap?.[scenario.reasoning];
      const effort =
        typeof mapped === "string"
          ? mapped
          : scenario.reasoning === "minimal"
            ? "low"
            : scenario.reasoning;
      Object.assign(options, { thinkingEnabled: true });
      if (
        config.model.compat &&
        "forceAdaptiveThinking" in config.model.compat &&
        config.model.compat.forceAdaptiveThinking === true
      ) {
        Object.assign(options, { effort });
      } else {
        const modelLimit = config.model.maxTokens ?? options.maxTokens;
        if (modelLimit === undefined) {
          throw new Error("预算思考场景缺少输出预算。");
        }
        const adjusted = adjustMaxTokensForThinking(
          options.maxTokens,
          modelLimit,
          scenario.reasoning,
          config.options.thinkingBudgets,
        );
        const transcript = normalizeContext(context);
        const maxTokens = clampMaxTokensToContext(config.model, transcript, adjusted.maxTokens);
        const thinkingBudgetTokens = clampThinkingBudgetToAnswerRoom(
          adjusted.thinkingBudget,
          maxTokens,
        );
        Object.assign(options, { maxTokens, thinkingBudgetTokens });
      }
    } else {
      Object.assign(options, { reasoningEffort: scenario.reasoning });
    }
  }
  const simple: SimpleStreamOptions = {
    ...config.options,
    signal,
    reasoning: scenario.reasoning ?? config.options.reasoning,
    toolChoice: scenario.disableTools ? "none" : "auto",
  };
  if (method === "complete") {
    return await complete(config.model, context, options);
  }
  if (method === "completeSimple") {
    return await completeSimple(config.model, context, simple);
  }
  const events =
    method === "stream"
      ? stream(config.model, context, options)
      : streamSimple(config.model, context, simple);
  return await consumeStream(events, config.options.apiKey);
}

/**
 * 校验并执行仅用于演示的本地工具，异常转为工具错误消息。
 * @param call - 模型返回的工具调用。
 * @param tools - 当前可调用工具的声明。
 * @param image - 已读取的演示图片。
 * @returns 与调用 ID 对应的文本或图片工具结果。
 */
function executeTool(call: ToolCall, tools: Tool[], image: ImageContent): ToolResultMessage {
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [],
    isError: false,
    timestamp: Date.now(),
  };
  try {
    const args = validateToolCall(tools, call) as Record<string, unknown>;
    if (call.name === "get_demo_image") {
      result.content = [{ type: "text", text: "docs/logo.jpg。" }, image];
      return result;
    }
    if (call.name === "fail_demo") {
      throw new Error("演示工具执行失败，请向用户说明错误，不要重复调用。");
    }
    if (call.name === "add_numbers" && typeof args.a === "number" && typeof args.b === "number") {
      result.content = [{ type: "text", text: String(args.a + args.b) }];
      return result;
    }
    if (call.name === "echo_text" && typeof args.input === "string") {
      result.content = [{ type: "text", text: args.input }];
      return result;
    }
    throw new Error("演示工具或参数不受支持。");
  } catch (error: unknown) {
    result.isError = true;
    result.content = [{ type: "text", text: error instanceof Error ? error.message : "工具失败" }];
    return result;
  }
}

function assertMessage(message: AssistantMessage): void {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? `请求状态：${message.stopReason}`);
  }
  if (message.stopReason === "length") {
    throw new Error("模型输出被截断，请调整输出预算后再运行。");
  }
}

/**
 * 完成一个场景的工具闭环和可选后续对话，并统计真实调用结果。
 * @param method - 当前公开调用入口。
 * @param config - 当前模型配置。
 * @param scenario - 待执行场景。
 * @param image - 工具可返回的演示图片。
 * @param signal - 当前运行的中断信号。
 * @returns 场景成功时完成；失败时拒绝。
 * @throws 请求失败、工具未被调用或工具闭环超过上限时抛出错误。
 */
async function runScenario(
  method: Method,
  config: ResolvedAiConfig,
  scenario: Scenario,
  image: ImageContent,
  signal: AbortSignal,
): Promise<void> {
  const initial: Message =
    scenario.imageOnly && scenario.images
      ? { role: "user", content: scenario.images, timestamp: Date.now() }
      : scenario.images
        ? userMessage(scenario.images, scenario.prompt)
        : userMessage(scenario.prompt);
  const context: Context = {
    systemPrompt: "你正在运行接口功能演示，请用简短中文回答，调用工具后根据真实结果回答。",
    messages: [initial],
    tools: scenario.dynamicTools ? undefined : scenario.tools,
  };
  if (scenario.dynamicTools) {
    context.messages.unshift({
      role: "system",
      content: context.systemPrompt ?? "",
      toolsAdded: [ECHO_TOOL],
      timestamp: Date.now(),
    });
    delete context.systemPrompt;
    context.messages.push({
      role: "system",
      content: "现在加入演示工具。",
      toolsAdded: scenario.tools,
      timestamp: Date.now(),
    });
  }
  let hasToolCall = false;
  let hasRequiredToolCall = false;
  let isFollowingUp = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const activeScenario = hasToolCall ? { ...scenario, requireTool: false } : scenario;
    const message = await callModel(method, config, context, activeScenario, signal);
    assertMessage(message);
    context.messages.push(message);
    console.log(
      JSON.stringify({
        stopReason: message.stopReason,
        usage: message.usage,
        responseModel: message.responseModel,
        responseId: message.responseId,
      }),
    );
    const text = contentText(message.content);
    const visibleText = redact(text, config.options.apiKey);
    console.log(visibleText);
    const calls = message.content.filter(
      (block: AssistantMessage["content"][number]): block is ToolCall => block.type === "toolCall",
    );
    if (calls.length > 0) {
      if (scenario.disableTools) {
        throw new Error("禁止工具的场景仍产生了工具调用。");
      }
      hasToolCall = true;
      for (const call of calls) {
        if (call.name === scenario.tools?.[0]?.name) {
          hasRequiredToolCall = true;
        }
        const tools = scenario.dynamicTools
          ? [ECHO_TOOL, ...(scenario.tools ?? [])]
          : (scenario.tools ?? []);
        const result = executeTool(call, tools, image);
        context.messages.push(result);
      }
      continue;
    }
    if (scenario.requireTool && !hasRequiredToolCall) {
      throw new Error("场景要求调用工具，但模型没有返回工具调用。");
    }
    if (scenario.followUp && !isFollowingUp) {
      if (scenario.updateSystem) {
        context.messages.push({
          role: "system",
          content: "后续回答请使用一句中文。",
          sections: { demo: "不要复述系统提示。" },
          timestamp: Date.now(),
        });
      }
      context.messages.push(userMessage(scenario.followUp));
      isFollowingUp = true;
      continue;
    }
    return;
  }
  throw new Error(`场景超过 ${MAX_TOOL_ROUNDS} 轮调用上限。`);
}

/**
 * 按四种入口运行共同场景，并依照模型声明增加推理和受限工具场景。
 * @param config - 已加载的模型和请求选项。
 * @param image - docs/logo.jpg 对应的图片内容。
 * @param signal - 运行中断信号。
 * @param advanced - 当前协议可演示的额外场景。
 * @returns 成功、失败和跳过的场景统计。
 */
async function runProtocol(
  config: ResolvedAiConfig,
  image: ImageContent,
  signal: AbortSignal,
  advanced: Scenario[],
): Promise<DemoSummary> {
  const summary: DemoSummary = { passed: 0, failed: 0, skipped: 0 };
  const scenarios: Scenario[] = [
    { name: "普通聊天", prompt: "请用一句话介绍你能做什么。" },
    { name: "多轮聊天", prompt: "请记住演示数字是 37。", followUp: "刚才的演示数字是什么？" },
    {
      name: "系统提示更新",
      prompt: "请简单问好。",
      followUp: "解释一下这次系统提示更新后的回答要求。",
      updateSystem: true,
    },
    {
      name: "工具计算",
      prompt: "必须使用 add_numbers 计算 2 加 3，工具返回后直接回答结果。",
      tools: [ADD_TOOL],
      requireTool: true,
    },
    {
      name: "严格工具兼容回退",
      prompt: "使用 add_numbers 计算 2 加 3。",
      tools: [{ ...ADD_TOOL, constrainedSampling: { type: "json_schema", strict: "prefer" } }],
      requireTool: true,
    },
    {
      name: "工具错误",
      prompt: "调用 fail_demo 一次，然后向用户说明返回的错误，不要重试。",
      tools: [ERROR_TOOL],
      requireTool: true,
    },
    {
      name: "禁止工具",
      prompt: "直接说你好，不要使用工具。",
      tools: [ADD_TOOL],
      disableTools: true,
    },
    ...advanced,
  ];
  if (config.model.input?.includes("image")) {
    scenarios.push(
      { name: "仅图片输入", prompt: "", images: [image], imageOnly: true },
      { name: "图文聊天", prompt: "简短描述这张图片。", images: [image] },
      { name: "多图片", prompt: "这两张图片有什么关系？", images: [image, image] },
      {
        name: "图片多轮",
        prompt: "描述图片中的主要内容。",
        images: [image],
        followUp: "根据刚才的图片，补充一个细节。",
      },
      {
        name: "图片工具结果",
        prompt: "调用 get_demo_image，读取返回的图片后描述内容。",
        tools: [IMAGE_TOOL],
        requireTool: true,
      },
    );
  } else {
    console.log("跳过图片场景：模型 input 未声明 image。");
    summary.skipped += 5 * METHODS.length;
  }
  const levels = getSupportedThinkingLevels(config.model);
  const level = levels.find(
    (value: ModelThinkingLevel): value is NonNullable<SimpleStreamOptions["reasoning"]> =>
      value !== "off",
  );
  if (config.model.reasoning === true && level) {
    scenarios.push({
      name: "推理及签名重放",
      prompt: "简短说明 12 乘 13 的计算过程。",
      followUp: "使用刚才的结果计算再加 1。",
      reasoning: level,
    });
  } else {
    console.log("跳过推理场景：模型未明确声明支持思考或没有可用级别。");
    summary.skipped += METHODS.length;
  }
  for (const scenario of scenarios) {
    if (scenario.skipReason) {
      console.log(`跳过 ${scenario.name}：${scenario.skipReason}`);
      summary.skipped += METHODS.length;
      continue;
    }
    for (const method of METHODS) {
      if (signal.aborted) {
        throw new Error("演示已中断。");
      }
      console.log(`\n${config.model.api} / ${scenario.name} / ${method}`);
      try {
        await runScenario(method, config, scenario, image, signal);
        summary.passed++;
      } catch (error: unknown) {
        if (signal.aborted) {
          throw new Error("演示已中断。");
        }
        summary.failed++;
        const message = error instanceof Error ? error.message : "场景失败";
        console.error(redact(message, config.options.apiKey));
      }
    }
  }
  const aborted = new AbortController();
  aborted.abort();
  for (const method of METHODS) {
    const response = await callModel(
      method,
      config,
      { messages: [userMessage("中断演示")] },
      { name: "取消请求", prompt: "中断演示" },
      aborted.signal,
    );
    if (response.stopReason === "aborted") {
      summary.passed++;
    } else {
      summary.failed++;
    }
  }
  return summary;
}

/**
 * 根据显式兼容配置添加严格工具和语法工具场景。
 * @param model - 当前模型及能力声明。
 * @param scenarios - 已构造的协议专属场景。
 * @returns 添加适用场景与明确跳过原因后的同一场景列表。
 */
function advancedScenarios(model: Model, scenarios: Scenario[]): Scenario[] {
  const strict =
    model.api === "anthropic-messages"
      ? model.compat &&
        "supportsStrictTools" in model.compat &&
        model.compat.supportsStrictTools === true
      : model.compat &&
        "supportsStrictMode" in model.compat &&
        model.compat.supportsStrictMode === true;
  if (strict) {
    scenarios.push({
      name: "严格 JSON Schema 工具",
      prompt: "使用 add_numbers 计算 2 加 3。",
      tools: [{ ...ADD_TOOL, constrainedSampling: { type: "json_schema", strict: "require" } }],
      requireTool: true,
    });
  } else {
    scenarios.push({ name: "严格工具", prompt: "", skipReason: "配置未声明支持。" });
  }
  if (
    model.api !== "anthropic-messages" &&
    model.compat &&
    "supportsOpenAIGrammarTools" in model.compat &&
    model.compat.supportsOpenAIGrammarTools === true
  ) {
    scenarios.push({
      name: "语法工具",
      requireTool: true,
      prompt: "调用 echo_text，输入 hello，收到结果后原样回答。",
      tools: [
        {
          ...ECHO_TOOL,
          constrainedSampling: {
            type: "grammar",
            variants: { openai_regex: "[a-z]+", openai_lark: "start: /[a-z]+/" },
          },
        },
      ],
    });
  } else {
    scenarios.push({ name: "语法工具", prompt: "", skipReason: "当前协议或配置未声明支持。" });
  }
  return scenarios;
}

/**
 * 运行 OpenAI Completions 的四种入口及其已声明的工具和思考场景。
 * @param config - Completions 模型配置，保留 reasoningEffort、thinkingBudgets 和兼容选项。
 * @param image - 演示图片。
 * @param signal - 请求中断信号。
 * @returns 场景统计。
 */
async function openaiCompletions(
  config: ResolvedAiConfig,
  image: ImageContent,
  signal: AbortSignal,
): Promise<DemoSummary> {
  const advanced: Scenario[] = [];
  if (
    config.model.compat &&
    "supportsMidConvoToolAdditions" in config.model.compat &&
    config.model.compat.supportsMidConvoToolAdditions === true &&
    config.model.compat.supportsMidConvoSystemMessages === true
  ) {
    advanced.push({
      name: "会话新增工具",
      prompt: "调用 add_numbers 计算 2 加 3。",
      tools: [ADD_TOOL],
      dynamicTools: true,
      requireTool: true,
    });
  }
  return await runProtocol(config, image, signal, advancedScenarios(config.model, advanced));
}

/**
 * 运行 OpenAI Responses 的四种入口，保留原生摘要、服务等级和响应签名。
 * @param config - Responses 模型配置。
 * @param image - 演示图片。
 * @param signal - 请求中断信号。
 * @returns 场景统计。
 */
async function openaiResponse(
  config: ResolvedAiConfig,
  image: ImageContent,
  signal: AbortSignal,
): Promise<DemoSummary> {
  const advanced: Scenario[] = [];
  if (
    config.model.compat &&
    config.model.compat.supportsMidConvoSystemMessages === true &&
    (("supportsAdditionalTools" in config.model.compat &&
      config.model.compat.supportsAdditionalTools === true) ||
      ("supportsToolSearch" in config.model.compat &&
        config.model.compat.supportsToolSearch === true))
  ) {
    advanced.push({
      name: "会话新增工具及工具搜索",
      prompt: "调用 add_numbers 计算 2 加 3。",
      tools: [ADD_TOOL],
      dynamicTools: true,
      requireTool: true,
    });
  }
  return await runProtocol(config, image, signal, advancedScenarios(config.model, advanced));
}

/**
 * 运行 Anthropic Messages 的四种入口，保留预算思考、自适应思考和回退模型配置。
 * @param config - Messages 模型配置。
 * @param image - 演示图片。
 * @param signal - 请求中断信号。
 * @returns 场景统计。
 */
async function anthropicMessage(
  config: ResolvedAiConfig,
  image: ImageContent,
  signal: AbortSignal,
): Promise<DemoSummary> {
  const advanced: Scenario[] = [];
  if (
    config.model.compat &&
    "supportsMidConvoToolChanges" in config.model.compat &&
    config.model.compat.supportsMidConvoToolChanges === true &&
    config.model.compat.supportsMidConvoSystemMessages === true
  ) {
    advanced.push({
      name: "会话新增工具",
      prompt: "调用 add_numbers 计算 2 加 3。",
      tools: [ADD_TOOL],
      dynamicTools: true,
      requireTool: true,
    });
  }
  return await runProtocol(config, image, signal, advancedScenarios(config.model, advanced));
}

/**
 * 读取 settings.json 和 docs/logo.jpg，按配置协议运行全部适用的演示场景。
 * @param directory - 配置及图片目录，默认使用当前工作目录。
 * @param fetch - 可选请求传输，用于离线验证；未提供时使用适配器默认传输。
 * @returns 每个场景及入口的成功、失败、跳过数量。
 * @throws 配置或图片无效、协议不支持或用户中断运行时抛出错误。
 * @remarks 会发起多次模型请求；不修改配置和环境变量，不执行外部工具命令。仅直接运行本文件时启动。
 */
export async function main(
  directory: string = process.cwd(),
  fetch?: FetchFunction,
): Promise<DemoSummary> {
  const config = await loadAiConfig(directory);
  const bytes = await readFile(resolve(directory, "docs", "logo.jpg"));
  const signature = bytes.subarray(0, 3).toString("hex");
  if (signature !== "ffd8ff") {
    throw new Error("docs/logo.jpg 必须是 JPEG 图片。");
  }
  const image: ImageContent = {
    type: "image",
    data: bytes.toString("base64"),
    mimeType: "image/jpeg",
  };
  let rawEventCount = 0;
  config.options = {
    ...config.options,
    ...(fetch ? { fetch } : {}),
    /**
     * 观察请求构建并保留原始参数。
     * @param payload - 适配器生成的请求参数。
     * @returns 未修改的请求参数。
     */
    onPayload: (payload: unknown): unknown => {
      console.log("请求参数已构建。");
      return payload;
    },
    /**
     * 输出响应状态，避免记录认证信息。
     * @param response - HTTP 响应信息。
     */
    onResponse: (response: { status: number }): void => {
      console.log(`HTTP 状态：${response.status}`);
    },
    /**
     * 统计原生协议事件，不记录原始响应内容。
     * @param _event - 当前原生协议事件。
     */
    onStreamEvent: (_event: unknown): void => {
      rawEventCount++;
    },
  };
  const controller = new AbortController();
  /** 将用户中断转为当前请求的取消信号。 */
  const interrupt = (): void => {
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  try {
    let summary: DemoSummary;
    switch (config.model.api) {
      case "openai-completions":
        summary = await openaiCompletions(config, image, controller.signal);
        break;
      case "openai-responses":
        summary = await openaiResponse(config, image, controller.signal);
        break;
      case "anthropic-messages":
        summary = await anthropicMessage(config, image, controller.signal);
        break;
      default:
        throw new Error("不支持的协议。");
    }
    console.log(
      `演示完成：成功 ${summary.passed}，失败 ${summary.failed}，跳过 ${summary.skipped}。`,
    );
    console.log(`原生协议事件数量：${rawEventCount}。`);
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

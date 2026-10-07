import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { shortHash } from "../../../src/llm-api/utils/hash.ts";
import {
  appendOpenAIReasoningDetail,
  buildParams,
  isOpenAIReasoningDetail,
  type ResolvedOpenAICompletionsCompat,
} from "../../../src/llm-api/api/openai-completions-request.ts";
import { normalizeContext } from "../../../src/llm-api/utils/transcript.ts";
import { testModel } from "../fixtures.ts";
import { assistant, tool } from "../helpers.ts";

function compat(): ResolvedOpenAICompletionsCompat {
  return {
    supportsStore: true,
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    maxTokensField: "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: false,
    thinkingFormat: "openai",
    openRouterRouting: {},
    vercelGatewayRouting: undefined,
    chatTemplateKwargs: {},
    chatTemplateArgs: {},
    zaiToolStream: false,
    supportsThinkingTokenBudget: false,
    thinkingTokenBudgetField: undefined,
    supportsStrictMode: false,
    supportsOpenAIGrammarTools: false,
    supportsMidConvoSystemMessages: false,
    supportsMidConvoToolAdditions: false,
    cacheControlFormat: undefined,
    sendSessionAffinityHeaders: false,
    sessionAffinityFormat: "openai",
    supportsLongCacheRetention: true,
    vllmPriority: undefined,
  };
}

describe("buildParams", (): void => {
  it("构建模型消息工具和最大输出字段", (): void => {
    const context = normalizeContext({
      systemPrompt: "系统提示",
      tools: [tool("echo")],
      messages: [{ role: "user", content: "问题", timestamp: 0 }],
    });
    const result = buildParams(
      testModel("openai-completions"),
      context,
      { apiKey: "test-key", maxTokens: 128 },
      compat(),
      "none",
      new Map(),
    );
    deepStrictEqual(result.messages, [
      { role: "system", content: "系统提示" },
      { role: "user", content: "问题" },
    ]);
    strictEqual(result.tools?.length, 1);
    strictEqual(result.max_completion_tokens, 128);
    strictEqual(result.store, false);
    deepStrictEqual(result.stream_options, { include_usage: true });
  });

  it("空会话没有工具和缓存字段且温度零保留", (): void => {
    const result = buildParams(
      testModel("openai-completions"),
      normalizeContext({ messages: [] }),
      { apiKey: "test-key", temperature: 0 },
      compat(),
      "none",
      new Map(),
    );
    deepStrictEqual(result.messages, []);
    strictEqual(result.tools, undefined);
    strictEqual(result.prompt_cache_key, undefined);
    strictEqual(result.prompt_cache_retention, undefined);
    strictEqual(result.temperature, 0);
  });

  it("严格工具要求不被端点支持时抛出原错误", (): void => {
    const strictTool = {
      ...tool(),
      constrainedSampling: { type: "json_schema" as const, strict: "require" as const },
    };
    const context = normalizeContext({ messages: [], tools: [strictTool] });
    const model = testModel("openai-completions");
    const config = compat();
    throws((): void => {
      buildParams(model, context, { apiKey: "test-key" }, config, "none", new Map());
    }, /strict/);
  });
});

describe("isOpenAIReasoningDetail", (): void => {
  it("接受三种推理数据类型及合法公共字段", (): void => {
    for (const detail of [
      { type: "reasoning.summary", summary: "摘要", id: null },
      { type: "reasoning.text", text: "思考", signature: null, index: 0, format: "test" },
      { type: "reasoning.encrypted", data: "密文" },
    ]) {
      strictEqual(isOpenAIReasoningDetail(detail), true);
    }
  });
  it("空值和空对象不是推理数据", (): void => {
    for (const detail of [undefined, null, [], {}]) {
      strictEqual(isOpenAIReasoningDetail(detail), false);
    }
  });
  it("拒绝错误公共字段正文和签名类型", (): void => {
    for (const detail of [
      { type: "reasoning.text", text: 1 },
      { type: "reasoning.text", text: "", signature: 1 },
      { type: "reasoning.summary", summary: "", id: 1 },
      { type: "reasoning.encrypted", data: "", index: "0" },
      { type: "reasoning.summary", summary: "", format: false },
      { type: "unknown", text: "" },
    ]) {
      strictEqual(isOpenAIReasoningDetail(detail), false);
    }
  });
});

describe("appendOpenAIReasoningDetail", (): void => {
  it("合并相邻文本及摘要并保留首次非空签名", (): void => {
    const details: Parameters<typeof appendOpenAIReasoningDetail>[0] = [];
    appendOpenAIReasoningDetail(details, {
      type: "reasoning.text",
      text: "甲",
      signature: "首签名",
    });
    appendOpenAIReasoningDetail(details, {
      type: "reasoning.text",
      text: "乙",
      signature: "后签名",
      id: "r1",
    });
    appendOpenAIReasoningDetail(details, { type: "reasoning.summary", summary: "概" });
    appendOpenAIReasoningDetail(details, { type: "reasoning.summary", summary: "述", index: 2 });
    deepStrictEqual(details, [
      {
        type: "reasoning.text",
        text: "甲乙",
        signature: "首签名",
        id: "r1",
        format: undefined,
        index: undefined,
      },
      { type: "reasoning.summary", summary: "概述", id: undefined, format: undefined, index: 2 },
    ]);
  });
  it("空列表追加浅拷贝且加密条目始终独立保存", (): void => {
    const details: Parameters<typeof appendOpenAIReasoningDetail>[0] = [];
    const detail: Parameters<typeof appendOpenAIReasoningDetail>[1] = {
      type: "reasoning.encrypted",
      data: "",
    };
    appendOpenAIReasoningDetail(details, detail);
    appendOpenAIReasoningDetail(details, detail);
    deepStrictEqual(details, [detail, detail]);
    strictEqual(details[0] === detail, false);
    strictEqual(details[0] === details[1], false);
  });
  it("无法修改冻结列表时传播异常", (): void => {
    const details: Parameters<typeof appendOpenAIReasoningDetail>[0] = [];
    Object.freeze(details);
    throws((): void => {
      appendOpenAIReasoningDetail(details, { type: "reasoning.encrypted", data: "密文" });
    }, TypeError);
  });
});

describe("buildParams：兼容端点分支", (): void => {
  it("各推理格式正确启用、关闭并映射等级", (): void => {
    const cases: Array<{
      format: ResolvedOpenAICompletionsCompat["thinkingFormat"];
      enabled: Record<string, unknown>;
      disabled: Record<string, unknown>;
    }> = [
      {
        format: "zai",
        enabled: {
          thinking: { type: "enabled", clear_thinking: false },
          reasoning_effort: "mapped",
        },
        disabled: { thinking: { type: "disabled" } },
      },
      {
        format: "qwen",
        enabled: { enable_thinking: true, reasoning_effort: "mapped" },
        disabled: { enable_thinking: false },
      },
      {
        format: "qwen-chat-template",
        enabled: { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } },
        disabled: { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } },
      },
      {
        format: "deepseek",
        enabled: { thinking: { type: "enabled" }, reasoning_effort: "mapped" },
        disabled: { thinking: { type: "disabled" } },
      },
      {
        format: "openrouter",
        enabled: { reasoning: { effort: "mapped" } },
        disabled: { reasoning: { effort: "off-value" } },
      },
      { format: "ant-ling", enabled: { reasoning: { effort: "mapped" } }, disabled: {} },
      {
        format: "together",
        enabled: { reasoning: { enabled: true }, reasoning_effort: "mapped" },
        disabled: { reasoning: { enabled: false } },
      },
      {
        format: "string-thinking",
        enabled: { thinking: "mapped" },
        disabled: { thinking: "off-value" },
      },
      {
        format: "openai",
        enabled: { reasoning_effort: "mapped" },
        disabled: { reasoning_effort: "off-value" },
      },
      {
        format: "baseten",
        enabled: { reasoning_effort: "mapped" },
        disabled: { reasoning_effort: "off-value" },
      },
    ];
    for (const entry of cases) {
      const model = {
        ...testModel("openai-completions"),
        reasoning: true,
        thinkingLevelMap: { high: "mapped", off: "off-value" },
      };
      const config = { ...compat(), thinkingFormat: entry.format };
      const enabled = buildParams(
        model,
        normalizeContext({ messages: [] }),
        { apiKey: "test-key", reasoningEffort: "high" },
        config,
        "none",
        new Map(),
      ) as unknown as Record<string, unknown>;
      const disabled = buildParams(
        model,
        normalizeContext({ messages: [] }),
        { apiKey: "test-key" },
        config,
        "none",
        new Map(),
      ) as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(entry.enabled)) {
        deepStrictEqual(enabled[key], value, entry.format);
      }
      for (const [key, value] of Object.entries(entry.disabled)) {
        deepStrictEqual(disabled[key], value, entry.format);
      }
      const nonReasoning = buildParams(
        { ...model, reasoning: false },
        normalizeContext({ messages: [] }),
        { apiKey: "test-key", reasoningEffort: "high" },
        config,
        "none",
        new Map(),
      );
      strictEqual(nonReasoning.reasoning_effort, undefined);
    }
  });

  it("未知推理能力不发送关闭字段且空映射省略等级", (): void => {
    for (const thinkingFormat of [
      "zai",
      "qwen",
      "qwen-chat-template",
      "baseten",
      "deepseek",
      "openrouter",
      "ant-ling",
      "together",
      "string-thinking",
      "openai",
    ] as const) {
      const config = { ...compat(), thinkingFormat };
      const output = buildParams(
        testModel("openai-completions"),
        normalizeContext({ messages: [] }),
        { apiKey: "test-key" },
        config,
        "none",
        new Map(),
      ) as unknown as Record<string, unknown>;
      for (const key of [
        "thinking",
        "reasoning",
        "enable_thinking",
        "chat_template_kwargs",
        "reasoning_effort",
      ]) {
        strictEqual(output[key], undefined, thinkingFormat);
      }
      const mapped = buildParams(
        {
          ...testModel("openai-completions"),
          reasoning: true,
          thinkingLevelMap: { high: null, off: null },
        },
        normalizeContext({ messages: [] }),
        { apiKey: "test-key", reasoningEffort: "high" },
        config,
        "none",
        new Map(),
      );
      if (["zai", "qwen", "baseten", "ant-ling"].includes(thinkingFormat)) {
        strictEqual(mapped.reasoning_effort, thinkingFormat === "qwen" ? "high" : undefined);
      }
      const disabled = buildParams(
        { ...testModel("openai-completions"), reasoning: true, thinkingLevelMap: { off: null } },
        normalizeContext({ messages: [] }),
        { apiKey: "test-key" },
        config,
        "none",
        new Map(),
      ) as unknown as Record<string, unknown>;
      if (["deepseek", "openrouter", "string-thinking"].includes(thinkingFormat)) {
        strictEqual(disabled.thinking, undefined);
        strictEqual(disabled.reasoning, undefined);
      }
    }
  });

  it("模板替换预算、布尔、等级和字面值，关闭时按配置省略", (): void => {
    for (const thinkingFormat of ["chat-template", "baseten"] as const) {
      const values = {
        literal: null,
        enabled: { $var: "thinking.enabled" as const },
        budget: { $var: "thinking.budget" as const },
        effort: { $var: "thinking.effort" as const },
        omitted: { $var: "thinking.enabled" as const, omitWhenOff: true },
      };
      const config = {
        ...compat(),
        thinkingFormat,
        chatTemplateKwargs: values,
        chatTemplateArgs: values,
        supportsThinkingTokenBudget: true,
        maxTokensField: "max_tokens" as const,
        supportsStore: false,
        supportsUsageInStreaming: false,
        vllmPriority: 0,
      };
      const model = {
        ...testModel("openai-completions"),
        reasoning: true,
        thinkingLevelMap: { off: "none" },
        compat: {
          openRouterRouting: { only: ["provider"] },
          vercelGatewayRouting: { order: ["gateway"] },
        },
      };
      const output = buildParams(
        model,
        normalizeContext({ messages: [] }),
        {
          apiKey: "test-key",
          reasoningEffort: "low",
          thinkingBudgets: { low: 100 },
          maxTokens: 2000,
          toolChoice: "none",
          samplingParams: { temperature: 0.25 },
        },
        config,
        "long",
        new Map(),
      ) as unknown as Record<string, unknown>;
      const key = thinkingFormat === "baseten" ? "chat_template_args" : "chat_template_kwargs";
      deepStrictEqual(output[key], {
        literal: null,
        enabled: true,
        budget: 100,
        effort: "low",
        omitted: true,
      });
      strictEqual(output.thinking_token_budget, 100);
      strictEqual(output.max_tokens, 2000);
      strictEqual(output.store, undefined);
      strictEqual(output.stream_options, undefined);
      strictEqual(output.priority, 0);
      strictEqual(output.tool_choice, "none");
      strictEqual(output.temperature, 0.25);
      deepStrictEqual(output.provider, { only: ["provider"] });
      deepStrictEqual(output.providerOptions, { gateway: { order: ["gateway"] } });
      const disabled = buildParams(
        model,
        normalizeContext({ messages: [] }),
        { apiKey: "test-key" },
        config,
        "none",
        new Map(),
      ) as unknown as Record<string, unknown>;
      deepStrictEqual(disabled[key], { literal: null, enabled: false, effort: "none" });
      const empty = buildParams(
        testModel("openai-completions"),
        normalizeContext({ messages: [] }),
        { apiKey: "test-key" },
        {
          ...config,
          chatTemplateArgs: { enabled: values.enabled },
          chatTemplateKwargs: { enabled: values.enabled },
        },
        "none",
        new Map(),
      ) as unknown as Record<string, unknown>;
      strictEqual(empty[key], undefined);
    }
  });

  it("回放推理签名、工具历史及图片并正确标记缓存", (): void => {
    const model = {
      ...testModel("openai-completions"),
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
    };
    const history = assistant({
      api: model.api,
      baseUrl: model.baseUrl,
      model: model.id,
      content: [
        { type: "thinking", thinking: "推理", thinkingSignature: "reasoning_content" },
        { type: "text", text: "答复" },
        { type: "toolCall", id: "call|item+", name: "echo", arguments: { value: 1 } },
      ],
    });
    const context = normalizeContext({
      systemPrompt: "规则",
      messages: [
        history,
        {
          role: "toolResult",
          toolCallId: "call|item+",
          toolName: "echo",
          content: [{ type: "image", mimeType: "image/png", data: "AQ==" }],
          isError: false,
          timestamp: 2,
        },
        { role: "user", content: "继续", timestamp: 3 },
      ],
    });
    const config = {
      ...compat(),
      requiresToolResultName: true,
      requiresAssistantAfterToolResult: true,
      requiresReasoningContentOnAssistantMessages: true,
      cacheControlFormat: "anthropic" as const,
    };
    const result = buildParams(
      model,
      context,
      { apiKey: "test-key", sessionId: "会话" },
      config,
      "long",
      new Map(),
    );
    strictEqual(result.prompt_cache_key, "会话");
    strictEqual(result.prompt_cache_retention, "24h");
    deepStrictEqual(result.tools, []);
    deepStrictEqual(result.messages[0], {
      role: "developer",
      content: [{ type: "text", text: "规则", cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
    const converted = result.messages[1] as unknown as Record<string, unknown>;
    strictEqual(converted.reasoning_content, "推理");
    deepStrictEqual(converted.tool_calls, [
      { id: "call|item+", type: "function", function: { name: "echo", arguments: '{"value":1}' } },
    ]);
    deepStrictEqual(result.messages[2], {
      role: "tool",
      content: "(see attached image)",
      tool_call_id: "call|item+",
      name: "echo",
    });
    strictEqual(result.messages[3]?.role, "assistant");
    strictEqual(result.messages[4]?.role, "user");
    deepStrictEqual(result.messages[5], {
      role: "user",
      content: [{ type: "text", text: "继续", cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
  });

  it("无可见内容的助手与空用户块被忽略，工具结果无输出有占位", (): void => {
    const model = testModel("openai-completions");
    const context = normalizeContext({
      messages: [
        assistant({ model: model.id, content: [], stopReason: "stop" }),
        { role: "user", content: [{ type: "text", text: "" }], timestamp: 2 },
        {
          role: "toolResult",
          toolCallId: "orphan",
          toolName: "echo",
          content: [],
          isError: false,
          timestamp: 3,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "继续" },
            { type: "image", mimeType: "image/png", data: "AQ==" },
          ],
          timestamp: 4,
        },
      ],
    });
    const result = buildParams(
      model,
      context,
      { apiKey: "test-key" },
      { ...compat(), requiresAssistantAfterToolResult: true },
      "none",
      new Map(),
    );
    strictEqual(result.messages[0]?.role, "tool");
    deepStrictEqual(result.messages[0], {
      role: "tool",
      tool_call_id: "orphan",
      content: "(no tool output)",
    });
    strictEqual(result.messages[1]?.role, "assistant");
    deepStrictEqual(result.messages[2], {
      role: "user",
      content: [
        { type: "text", text: "继续" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQ==" } },
      ],
    });
  });

  it("合法结构化签名保留，坏签名不回放且思考可转文本", (): void => {
    const model = testModel("openai-completions");
    for (const signature of [
      '[{"type":"reasoning.text","text":"思考"}]',
      "无效JSON",
      "[]",
      "[{}]",
      "reasoning_text",
      undefined,
    ]) {
      const message = assistant({
        model: model.id,
        content: [
          { type: "thinking", thinking: "思考", thinkingSignature: signature },
          { type: "text", text: "回答" },
        ],
      });
      const context = normalizeContext({ messages: [message] });
      const output = buildParams(
        model,
        context,
        { apiKey: "test-key" },
        compat(),
        "none",
        new Map(),
      ).messages[0] as unknown as Record<string, unknown>;
      if (signature?.startsWith('[{"type"')) {
        deepStrictEqual(output.reasoning_details, [{ type: "reasoning.text", text: "思考" }]);
      } else {
        strictEqual(output.reasoning_details, undefined);
      }
      strictEqual(output.content, "回答");
      const text = buildParams(
        model,
        context,
        { apiKey: "test-key" },
        { ...compat(), requiresThinkingAsText: true },
        "none",
        new Map(),
      ).messages[0];
      deepStrictEqual(text?.content, [
        { type: "text", text: "思考" },
        { type: "text", text: "回答" },
      ]);
    }
  });
});

describe("Completions 回放与缓存边界", (): void => {
  it("跨模型工具 ID 清洗、截断与散列避免组合标识冲突", (): void => {
    const model = { ...testModel("openai-completions"), baseUrl: "https://api.openai.com/v1" };
    for (const id of ["short", "short|", "a+|b/", "x".repeat(50), `${"x".repeat(50)}|item`]) {
      const context = normalizeContext({
        messages: [
          assistant({
            model: "other-model",
            content: [{ type: "toolCall", id, name: "echo", arguments: {} }],
          }),
        ],
      });
      const output = buildParams(
        model,
        context,
        { apiKey: "test-key" },
        compat(),
        "none",
        new Map(),
      );
      const call = output.messages[0];
      const expected =
        id === "short|" || id === "short"
          ? "short"
          : id === "a+|b/"
            ? "a__b_"
            : id.includes("|")
              ? `${"x".repeat(31)}_${shortHash(id).slice(0, 8)}`
              : "x".repeat(40);
      deepStrictEqual(call, {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: expected, type: "function", function: { name: "echo", arguments: "{}" } },
        ],
      });
      strictEqual(output.messages[1]?.role, "tool");
    }
  });
  it("缓存越过空字符串、纯图片及无正文的助手并标记最后工具", (): void => {
    const model = testModel("openai-completions");
    const context = normalizeContext({
      tools: [tool("echo")],
      messages: [
        { role: "user", content: "前文", timestamp: 0 },
        assistant({
          model: model.id,
          content: [{ type: "toolCall", id: "a", name: "echo", arguments: {} }],
        }),
        {
          role: "toolResult",
          toolCallId: "a",
          toolName: "echo",
          content: [],
          isError: false,
          timestamp: 1,
        },
        {
          role: "user",
          content: [{ type: "image", mimeType: "image/png", data: "AQ==" }],
          timestamp: 2,
        },
        { role: "user", content: "", timestamp: 3 },
      ],
    });
    const result = buildParams(
      model,
      context,
      { apiKey: "test-key" },
      {
        ...compat(),
        cacheControlFormat: "anthropic",
        supportsLongCacheRetention: false,
        zaiToolStream: true,
      },
      "long",
      new Map(),
    ) as unknown as Record<string, unknown>;
    strictEqual(result.prompt_cache_retention, undefined);
    strictEqual(result.tool_stream, true);
    const convertedTools = result.tools as Array<Record<string, unknown>>;
    deepStrictEqual(convertedTools[0]?.cache_control, { type: "ephemeral" });
    const messages = result.messages as Array<Record<string, unknown>>;
    deepStrictEqual(messages[2]?.content, [
      { type: "text", text: "(no tool output)", cache_control: { type: "ephemeral" } },
    ]);
    const onlyCall = normalizeContext({
      messages: [
        assistant({
          model: model.id,
          content: [{ type: "toolCall", id: "a", name: "echo", arguments: {} }],
        }),
      ],
    });
    buildParams(
      model,
      onlyCall,
      { apiKey: "test-key" },
      { ...compat(), cacheControlFormat: "anthropic" },
      "short",
      new Map(),
    );
  });
  it("grammar 工具与历史输入按原字段回放，动态工具只附加新增声明", (): void => {
    const model = testModel("openai-completions");
    const declaredTool = {
      name: "echo",
      description: "回显",
      parameters: Type.Object({ input: Type.String() }),
      constrainedSampling: { type: "grammar" as const, variants: { openai_regex: ".*" } },
    };
    const history = assistant({
      model: model.id,
      content: [{ type: "toolCall", id: "a", name: "echo", arguments: { input: "内容" } }],
    });
    const context = normalizeContext({
      messages: [
        { role: "system", content: "初始", toolsAdded: [declaredTool], timestamp: 0 },
        history,
        {
          role: "toolResult",
          toolCallId: "a",
          toolName: "echo",
          content: [],
          isError: false,
          timestamp: 1,
        },
        { role: "system", content: "更新", toolsAdded: [tool("new")], timestamp: 2 },
      ],
    });
    const config = {
      ...compat(),
      supportsOpenAIGrammarTools: true,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolAdditions: true,
    };
    const output = buildParams(
      model,
      context,
      { apiKey: "test-key" },
      config,
      "none",
      new Map([["echo", "input"]]),
    );
    deepStrictEqual(output.tools, [
      {
        type: "custom",
        custom: {
          name: "echo",
          description: "回显",
          format: { type: "grammar", grammar: { syntax: "regex", definition: ".*" } },
        },
      },
    ]);
    const message = output.messages[1];
    deepStrictEqual(message, {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "a", type: "custom", custom: { name: "echo", input: "内容" } }],
    });
    const addition = output.messages[3] as unknown as Record<string, unknown>;
    strictEqual(addition.role, "system");
    strictEqual((addition.tools as unknown[]).length, 1);
  });
});

describe("Completions 缺省推理及预算边界", (): void => {
  it("无映射等级直接透传，关闭时嵌套推理格式使用 none", (): void => {
    const model = { ...testModel("openai-completions"), reasoning: true };
    for (const thinkingFormat of [
      "zai",
      "qwen",
      "baseten",
      "deepseek",
      "openrouter",
      "together",
      "string-thinking",
      "openai",
    ] as const) {
      const config = { ...compat(), thinkingFormat };
      const enabled = buildParams(
        model,
        normalizeContext({ messages: [] }),
        { apiKey: "test-key", reasoningEffort: "high" },
        config,
        "none",
        new Map(),
      ) as unknown as Record<string, unknown>;
      if (["zai", "qwen", "baseten", "deepseek", "together", "openai"].includes(thinkingFormat)) {
        strictEqual(enabled.reasoning_effort, "high");
      }
      const disabled = buildParams(
        model,
        normalizeContext({ messages: [] }),
        { apiKey: "test-key" },
        config,
        "none",
        new Map(),
      ) as unknown as Record<string, unknown>;
      if (thinkingFormat === "openrouter") {
        deepStrictEqual(disabled.reasoning, { effort: "none" });
      }
      if (thinkingFormat === "string-thinking") {
        strictEqual(disabled.thinking, "none");
      }
    }
  });
  it("未知输出上限保留预算，零预算不发送，null 等级模板省略", (): void => {
    const model = { ...testModel("openai-completions"), reasoning: true };
    delete model.maxTokens;
    const config = { ...compat(), supportsThinkingTokenBudget: true };
    const context = normalizeContext({ messages: [assistant({ model: model.id })] });
    const output = buildParams(
      model,
      context,
      { apiKey: "test-key", reasoningEffort: "high", thinkingBudgets: { high: 100 } },
      { ...config, requiresReasoningContentOnAssistantMessages: true },
      "none",
      new Map(),
    ) as unknown as Record<string, unknown>;
    strictEqual(output.thinking_token_budget, 100);
    const messages = output.messages as Array<Record<string, unknown>>;
    strictEqual(messages[0]?.reasoning_content, "");
    const zero = buildParams(
      model,
      context,
      { apiKey: "test-key", reasoningEffort: "high", thinkingBudgets: { high: 0 } },
      config,
      "none",
      new Map(),
    ) as unknown as Record<string, unknown>;
    strictEqual(zero.thinking_token_budget, undefined);
    const omitted = buildParams(
      { ...model, thinkingLevelMap: { high: null } },
      normalizeContext({ messages: [] }),
      { apiKey: "test-key", reasoningEffort: "high" },
      {
        ...compat(),
        thinkingFormat: "chat-template",
        chatTemplateKwargs: { effort: { $var: "thinking.effort" } },
      },
      "none",
      new Map(),
    ) as unknown as Record<string, unknown>;
    strictEqual(omitted.chat_template_kwargs, undefined);
  });
});

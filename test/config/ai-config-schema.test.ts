import { deepStrictEqual, doesNotThrow, match, throws } from "node:assert";
import { describe, it } from "node:test";
import { validateAiConfig } from "../../src/config/ai-config-schema.ts";
import type { Api } from "../../src/llm-api/types.ts";

const COMMON_REQUEST = {
  apiKey: "请求密钥由加载器覆盖",
  env: { PI_CACHE_RETENTION: "long" },
  headers: { "x-default": null, "x-custom": "请求值" },
  timeoutMs: 1000,
  maxRetries: 0,
  maxRetryDelayMs: 60000,
  temperature: 0.5,
  samplingParams: { top_p: 0.9 },
  maxTokens: 2048,
  cacheRetention: "long",
  sessionId: "会话",
  metadata: { user_id: "用户", other: true },
  reasoning: "high",
  thinkingBudgets: { minimal: 128, low: 256, medium: 512, high: 1024 },
};
const COST = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
const COMMON_MODEL = {
  name: "展示名",
  input: ["text", "image"],
  inputLimits: {
    maxRequestBytes: 10000,
    images: {
      resize: { maxWidth: 1024, maxHeight: 1024, maxBytes: 10000, jpegQuality: 80 },
      maxPerMessage: 2,
      maxPerRequest: 4,
    },
  },
  cost: { ...COST, tiers: [{ inputTokensAbove: 100000, ...COST }] },
  headers: { "x-default": null },
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: "max",
  },
  promptCache: { short: 300, long: 3600 },
  contextWindow: 128000,
  maxTokens: 16384,
  samplingParams: { top_p: 0.95 },
  samplingParamsByThinkingLevel: {
    off: { temperature: 0.7 },
    minimal: {},
    low: {},
    medium: {},
    high: {},
    xhigh: {},
    max: {},
  },
};
const COMPLETIONS_COMPAT = {
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
  thinkingFormat: "chat-template",
  chatTemplateKwargs: {
    flag: true,
    number: 1,
    text: "字面值",
    empty: null,
    budget: { $var: "thinking.budget", omitWhenOff: true },
  },
  chatTemplateArgs: { enabled: { $var: "thinking.enabled" }, effort: { $var: "thinking.effort" } },
  zaiToolStream: true,
  thinkingTokenBudgetField: "thinking_token_budget",
  supportsThinkingTokenBudget: true,
  supportsOpenAIGrammarTools: true,
  supportsMidConvoSystemMessages: true,
  supportsMidConvoToolAdditions: true,
  supportsStrictMode: true,
  cacheControlFormat: "anthropic",
  sendSessionAffinityHeaders: true,
  sessionAffinityFormat: "openai-nosession",
  supportsLongCacheRetention: true,
  vllmPriority: 1,
  openRouterRouting: {
    allow_fallbacks: true,
    require_parameters: true,
    data_collection: "deny",
    zdr: true,
    enforce_distillable_text: true,
    order: ["端点"],
    only: ["端点"],
    ignore: [],
    quantizations: ["fp16"],
    sort: { by: "price", partition: null },
    max_price: { prompt: "1", completion: 2, image: 3, audio: 4, request: 5 },
    preferred_min_throughput: { p50: 1, p75: 2, p90: 3, p99: 4 },
    preferred_max_latency: 10,
  },
  vercelGatewayRouting: { only: ["端点"], order: ["端点"] },
};
const RESPONSES_COMPAT = {
  supportsDeveloperRole: true,
  supportsMidConvoSystemMessages: true,
  sessionAffinityFormat: "openai",
  supportsLongCacheRetention: true,
  supportsStrictMode: true,
  supportsOpenAIGrammarTools: true,
  supportsAdditionalTools: true,
  supportsToolSearch: true,
  supportsExplicitPromptCacheMode: true,
  supportsMaxOutputTokens: true,
};
const ANTHROPIC_COMPAT = {
  supportsEagerToolInputStreaming: true,
  supportsLongCacheRetention: true,
  sendSessionAffinityHeaders: true,
  sessionAffinityFormat: "openrouter",
  supportsCacheControlOnTools: true,
  supportsTemperature: true,
  forceAdaptiveThinking: true,
  allowEmptySignature: true,
  supportsStrictTools: true,
  supportsMidConvoEffort: true,
  supportsMidConvoSystemMessages: true,
  supportsMidConvoToolChanges: true,
  allowedFallbackModels: [{ model: "回退模型", cost: COST }, { model: "无费率回退模型" }],
};

/**
 * 创建用于结构校验的独立配置，使用精确的提供商与模型标识。
 * @param api - 被测协议。
 * @param model - 模型字段及请求选项。
 * @param requestOptions - 提供商请求默认值。
 * @returns 一个新的配置对象。
 */
function configFor(
  api: Api,
  model: Record<string, unknown> = {},
  requestOptions: unknown = {},
): object {
  return {
    provider: "服务",
    model: "模型",
    modelProviders: [
      {
        name: "服务",
        api,
        baseUrl: "https://example.test/v1",
        apiKey: "密钥",
        requestOptions,
        models: [{ id: "模型", ...model }],
      },
    ],
  };
}

describe("validateAiConfig", (): void => {
  it("完整校验三种协议的模型、兼容与静态请求字段", (): void => {
    const fixtures: [Api, Record<string, unknown>, object][] = [
      [
        "openai-completions",
        COMPLETIONS_COMPAT,
        { reasoningEffort: "xhigh", toolChoice: { type: "function", function: { name: "工具" } } },
      ],
      [
        "openai-responses",
        RESPONSES_COMPAT,
        {
          reasoningEffort: "max",
          reasoningSummary: "concise",
          serviceTier: "ultrafast",
          toolChoice: { type: "function", name: "工具" },
        },
      ],
      [
        "anthropic-messages",
        ANTHROPIC_COMPAT,
        {
          thinkingEnabled: true,
          thinkingBudgetTokens: 1024,
          effort: "xhigh",
          thinkingDisplay: "omitted",
          interleavedThinking: true,
          toolChoice: { type: "tool", name: "工具" },
        },
      ],
    ];
    for (const [api, compat, options] of fixtures) {
      const requestOptions = { ...COMMON_REQUEST, ...options };
      const config = configFor(api, { ...COMMON_MODEL, compat, requestOptions }, requestOptions);
      doesNotThrow((): void => validateAiConfig(config));
    }
  });

  it("支持当前 SDK 的全部工具选择结构与服务等级", (): void => {
    const completionsChoices: unknown[] = [
      "auto",
      "none",
      "required",
      { type: "function", function: { name: "工具" } },
      { type: "custom", custom: { name: "工具" } },
      {
        type: "allowed_tools",
        allowed_tools: {
          mode: "required",
          tools: [{ type: "function", function: { name: "工具" } }],
        },
      },
    ];
    const responsesChoices: unknown[] = [
      "auto",
      "none",
      "required",
      { type: "function", name: "工具" },
      { type: "custom", name: "工具" },
      { type: "mcp", server_label: "服务器", name: null },
      { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "工具" }] },
    ];
    const builtinTypes = [
      "file_search",
      "web_search_preview",
      "computer",
      "computer_use_preview",
      "computer_use",
      "web_search_preview_2025_03_11",
      "image_generation",
      "code_interpreter",
      "mcp",
      "apply_patch",
      "shell",
      "programmatic_tool_calling",
    ];
    for (const type of builtinTypes) {
      responsesChoices.push({ type });
    }
    const anthropicChoices: unknown[] = ["auto", "any", "none", { type: "tool", name: "工具" }];
    const cases: [Api, unknown[]][] = [
      ["openai-completions", completionsChoices],
      ["openai-responses", responsesChoices],
      ["anthropic-messages", anthropicChoices],
    ];
    for (const [api, choices] of cases) {
      for (const toolChoice of choices) {
        const config = configFor(api, { requestOptions: { toolChoice } }, { toolChoice });
        doesNotThrow((): void => validateAiConfig(config));
      }
    }
    const tiers = ["auto", "default", "flex", "scale", "priority", "fast", "ultrafast", null];
    for (const serviceTier of tiers) {
      const config = configFor("openai-responses", {}, { serviceTier, reasoningSummary: null });
      doesNotThrow((): void => validateAiConfig(config));
    }
  });

  it("允许空提供商列表、缺少可选字段、空映射与未知字段，并保持原值", (): void => {
    const fixtures = [
      { provider: "服务", model: "模型", modelProviders: [] },
      { provider: "服务", model: "模型", modelProviders: [{ name: "服务" }] },
      configFor(
        "openai-completions",
        {
          input: [],
          headers: {},
          compat: {},
          cost: COST,
          thinkingLevelMap: {},
          name: "",
          contextWindow: 0.5,
          maxTokens: 0.25,
          unknownModel: true,
        },
        { unknownRequest: "保留" },
      ),
      {
        provider: "服务",
        model: "模型",
        modelProviders: [{ name: "服务", unknownProvider: "保留" }],
        unknownRoot: "保留",
      },
    ];
    for (const config of fixtures) {
      const previous = structuredClone(config);
      validateAiConfig(config);
      deepStrictEqual(config, previous);
    }
  });

  it("拒绝根结构、提供商、模型与嵌套字段的错误类型或缺少必填项", (): void => {
    const fixtures: [unknown, RegExp][] = [
      [null, /root/],
      [{}, /provider/],
      [{ provider: "服务", modelProviders: [] }, /model/],
      [{ provider: "服务", model: "模型" }, /modelProviders/],
      [{ provider: "", model: "模型", modelProviders: [] }, /provider/],
      [{ provider: "服务", model: "模型", modelProviders: [{}] }, /modelProviders.0.name/],
      [configFor("openai-responses", { id: "" }), /models.0.id/],
      [configFor("openai-responses", { name: 1 }), /models.0.name/],
      [configFor("openai-responses", { contextWindow: 0 }), /contextWindow: exclusiveMinimum/],
      [configFor("openai-responses", { contextWindow: -1 }), /contextWindow: exclusiveMinimum/],
      [configFor("openai-responses", { maxTokens: 0 }), /maxTokens: exclusiveMinimum/],
      [configFor("openai-responses", { maxTokens: -1 }), /maxTokens: exclusiveMinimum/],
      [configFor("openai-responses", { cost: { input: 1 } }), /cost/],
      [configFor("openai-responses", { headers: { x: 1 } }), /headers.x/],
      [configFor("openai-responses", { input: ["audio"] }), /input/],
      [configFor("openai-responses", { thinkingLevelMap: { high: 1 } }), /thinkingLevelMap.high/],
      [configFor("openai-responses", { promptCache: { short: 0 } }), /promptCache.short/],
      [
        configFor("openai-responses", {
          inputLimits: { images: { resize: { jpegQuality: 101 } } },
        }),
        /jpegQuality/,
      ],
      [configFor("openai-responses", {}, { maxRetries: "0" }), /requestOptions.maxRetries/],
      [configFor("openai-responses", {}, { env: { key: null } }), /env.key/],
      [
        configFor("openai-responses", {}, { thinkingBudgets: { high: "1024" } }),
        /thinkingBudgets.high/,
      ],
      [configFor("openai-responses", {}, { serviceTier: "unsupported" }), /serviceTier/],
      [configFor("openai-responses", {}, { reasoningSummary: false }), /reasoningSummary/],
      [configFor("anthropic-messages", {}, { effort: "minimal" }), /effort/],
      [
        configFor("anthropic-messages", { compat: { allowedFallbackModels: [{}] } }),
        /allowedFallbackModels/,
      ],
      [
        configFor("openai-completions", {
          compat: { chatTemplateKwargs: { flag: { $var: "invalid" } } },
        }),
        /chatTemplateKwargs.flag/,
      ],
    ];
    for (const [config, path] of fixtures) {
      throws((): void => validateAiConfig(config), path);
    }
  });

  it("所有已知兼容布尔字段都拒绝错误类型", (): void => {
    const fixtures: [Api, Record<string, unknown>][] = [
      ["openai-completions", COMPLETIONS_COMPAT],
      ["openai-responses", RESPONSES_COMPAT],
      ["anthropic-messages", ANTHROPIC_COMPAT],
    ];
    for (const [api, compat] of fixtures) {
      for (const [key, value] of Object.entries(compat)) {
        if (typeof value !== "boolean") {
          continue;
        }
        const config = configFor(api, { compat: { [key]: "true" } });
        throws((): void => validateAiConfig(config), /compat/);
      }
    }
  });

  it("按提供商协议拒绝不匹配的亲和格式与工具结构", (): void => {
    const fixtures: [Api, Record<string, unknown>, object][] = [
      ["anthropic-messages", { compat: { sessionAffinityFormat: "openai" } }, {}],
      ["anthropic-messages", {}, { toolChoice: "required" }],
      ["openai-completions", {}, { toolChoice: { type: "function", name: "工具" } }],
      [
        "openai-completions",
        { requestOptions: { toolChoice: { type: "tool", name: "工具" } } },
        {},
      ],
      ["openai-responses", {}, { toolChoice: { type: "function", function: { name: "工具" } } }],
      ["openai-responses", { requestOptions: { toolChoice: "any" } }, {}],
    ];
    for (const [api, model, options] of fixtures) {
      const config = configFor(api, model, options);
      throws((): void => validateAiConfig(config), /compat|toolChoice/);
    }
  });

  it("异常只报告字段路径与校验关键字，不包含配置值", (): void => {
    const secret = "不可出现在错误中的密钥";
    const config = {
      provider: "服务",
      model: "模型",
      modelProviders: [{ name: "服务", apiKey: { secret } }],
    };
    throws(
      (): void => validateAiConfig(config),
      (error: unknown): boolean => {
        if (!(error instanceof Error)) {
          return false;
        }
        match(error.message, /^Configuration validation failed:\n/);
        match(error.message, /modelProviders.0.apiKey: type/);
        return !error.message.includes(secret);
      },
    );
  });
});

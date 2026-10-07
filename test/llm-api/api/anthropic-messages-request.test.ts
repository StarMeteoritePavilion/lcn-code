import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { Type } from "typebox";
import {
  buildParams,
  getAnthropicCompat,
  requireMaxTokens,
} from "../../../src/llm-api/api/anthropic-messages-request.ts";
import { normalizeContext } from "../../../src/llm-api/utils/transcript.ts";
import { testModel } from "../fixtures.ts";

describe("getAnthropicCompat", (): void => {
  it("读取显式能力并为其他能力填充原默认值", (): void => {
    const model = testModel("anthropic-messages");
    model.compat = { supportsTemperature: false, supportsStrictTools: true };
    deepStrictEqual(getAnthropicCompat(model), {
      supportsEagerToolInputStreaming: true,
      supportsLongCacheRetention: true,
      sendSessionAffinityHeaders: false,
      sessionAffinityFormat: undefined,
      supportsCacheControlOnTools: true,
      supportsTemperature: false,
      allowEmptySignature: false,
      supportsStrictTools: true,
      supportsMidConvoSystemMessages: false,
      supportsMidConvoToolChanges: false,
    });
  });

  it("openrouter 默认亲和格式能被显式配置覆盖", (): void => {
    const model = testModel("anthropic-messages");
    model.baseUrl = "https://openrouter.ai/api";
    strictEqual(getAnthropicCompat(model).sessionAffinityFormat, "openrouter");
    strictEqual(getAnthropicCompat(model).sendSessionAffinityHeaders, true);
    model.compat = { sendSessionAffinityHeaders: false };
    strictEqual(getAnthropicCompat(model).sendSessionAffinityHeaders, false);
  });

  it("无模型对象时保留属性读取异常", (): void => {
    throws((): unknown => Reflect.apply(getAnthropicCompat, undefined, [null]), TypeError);
  });
});

describe("requireMaxTokens", (): void => {
  it("请求上限优先于模型上限", (): void => {
    strictEqual(
      requireMaxTokens(testModel("anthropic-messages"), { apiKey: "test", maxTokens: 12 }),
      12,
    );
    strictEqual(requireMaxTokens(testModel("anthropic-messages")), 8192);
  });

  it("接受最小正整数及最大安全整数", (): void => {
    const model = testModel("anthropic-messages");
    strictEqual(requireMaxTokens(model, { apiKey: "test", maxTokens: 1 }), 1);
    strictEqual(
      requireMaxTokens(model, { apiKey: "test", maxTokens: Number.MAX_SAFE_INTEGER }),
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("拒绝缺少上限和非正安全整数", (): void => {
    const model = testModel("anthropic-messages");
    delete model.maxTokens;
    throws((): number => requireMaxTokens(model), /positive integer maxTokens/);
    for (const maxTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      throws(
        (): number => requireMaxTokens(model, { apiKey: "test", maxTokens }),
        /positive integer maxTokens/,
      );
    }
  });
});

describe("buildParams", (): void => {
  it("生成系统缓存、用户缓存、预算思考和旧式工具流 beta", (): void => {
    const model = testModel("anthropic-messages");
    model.compat = { supportsEagerToolInputStreaming: false };
    const context = normalizeContext({
      systemPrompt: "指令",
      tools: [
        { name: "echo", description: "回显", parameters: Type.Object({ input: Type.String() }) },
      ],
      messages: [{ role: "user", content: "问题", timestamp: 0 }],
    });
    const params = buildParams(model, context, {
      apiKey: "test",
      thinkingEnabled: true,
      thinkingBudgetTokens: 2048,
      cacheRetention: "long",
      temperature: 0.2,
    });
    deepStrictEqual(params.system, [
      { type: "text", text: "指令", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    deepStrictEqual(params.messages, [
      {
        role: "user",
        content: [{ type: "text", text: "问题", cache_control: { type: "ephemeral", ttl: "1h" } }],
      },
    ]);
    deepStrictEqual(params.thinking, {
      type: "enabled",
      budget_tokens: 2048,
      display: "summarized",
    });
    deepStrictEqual(params.betas, [
      "fine-grained-tool-streaming-2025-05-14",
      "interleaved-thinking-2025-05-14",
    ]);
    strictEqual(params.temperature, undefined);
    deepStrictEqual(params.tools, [
      {
        name: "echo",
        description: "回显",
        input_schema: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });

  it("空上下文、不缓存和显式禁用 beta 不增加请求字段", (): void => {
    const model = testModel("anthropic-messages");
    model.headers = { "anthropic-beta": "model-feature" };
    const params = buildParams(model, normalizeContext({ messages: [] }), {
      apiKey: "test",
      cacheRetention: "none",
      headers: { "anthropic-beta": null },
    });
    deepStrictEqual(params, { model: "test-model", messages: [], max_tokens: 8192, stream: true });
  });

  it("请求头 beta 去重且自适应思考省略预算与交错 beta", (): void => {
    const model = testModel("anthropic-messages");
    model.compat = { forceAdaptiveThinking: true };
    const params = buildParams(model, normalizeContext({ messages: [] }), {
      apiKey: "test",
      thinkingEnabled: true,
      effort: "low",
      thinkingDisplay: "omitted",
      headers: { "anthropic-beta": " a, a, b, " },
    });
    deepStrictEqual(params.betas, ["a", "b"]);
    deepStrictEqual(params.thinking, { type: "adaptive", display: "omitted" });
    deepStrictEqual(params.output_config, { effort: "low" });
  });

  it("无有效输出上限时直接拒绝构建请求", (): void => {
    const model = testModel("anthropic-messages");
    model.maxTokens = 0;
    throws(
      (): unknown => buildParams(model, normalizeContext({ messages: [] })),
      /positive integer maxTokens/,
    );
  });

  it("要求严格工具但端点不支持时保留原错误", (): void => {
    const context = normalizeContext({
      messages: [],
      tools: [
        {
          name: "echo",
          description: "回显",
          parameters: Type.Object({ input: Type.String() }),
          constrainedSampling: { type: "json_schema", strict: "require" },
        },
      ],
    });
    throws(
      (): unknown => buildParams(testModel("anthropic-messages"), context),
      /strict tools are unsupported/,
    );
  });
});

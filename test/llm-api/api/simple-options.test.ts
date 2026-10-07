import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  adjustMaxTokensForThinking,
  buildBaseOptions,
  clampMaxTokensToContext,
  clampThinkingBudgetToAnswerRoom,
  resolveSamplingParams,
  thinkingBudgetForLevel,
} from "../../../src/llm-api/api/simple-options.ts";
import type { Model, SimpleStreamOptions, ThinkingLevel } from "../../../src/llm-api/types.ts";
import { normalizeContext } from "../../../src/llm-api/utils/transcript.ts";
import { testModel } from "../fixtures.ts";

describe("clampMaxTokensToContext", (): void => {
  it("根据上下文文本及安全余量限制输出", (): void => {
    const model = { ...testModel("openai-completions"), contextWindow: 5000 };
    const context = normalizeContext({
      messages: [{ role: "user", content: "abcd", timestamp: 0 }],
    });
    strictEqual(clampMaxTokensToContext(model, context, 1000), 903);
  });
  it("无窗口时保留上限，窗口用尽时仍允许一个 token", (): void => {
    const model = testModel("openai-completions");
    const context = normalizeContext({ messages: [] });
    strictEqual(clampMaxTokensToContext(model, context, 100), 100);
    strictEqual(clampMaxTokensToContext({ ...model, contextWindow: 1 }, context, 100), 1);
    strictEqual(clampMaxTokensToContext(model, context, 0), 1);
  });
  it("拒绝不符合声明类型的模型", (): void => {
    throws((): void => {
      clampMaxTokensToContext(null as unknown as Model, normalizeContext({ messages: [] }), 100);
    }, TypeError);
  });
});

describe("resolveSamplingParams", (): void => {
  it("按请求、级别、模型优先级逐键合并", (): void => {
    const model: Model = {
      ...testModel("openai-completions"),
      samplingParams: { temperature: 0.8, top_p: 0.9 },
      samplingParamsByThinkingLevel: { high: { temperature: 0.6, top_k: 10 } },
    };
    deepStrictEqual(resolveSamplingParams(model, "high", { temperature: 0.2 }), {
      temperature: 0.2,
      top_p: 0.9,
      top_k: 10,
    });
    strictEqual(model.samplingParams?.temperature, 0.8);
  });
  it("缺省参数返回 undefined，不支持推理时使用 off 参数", (): void => {
    const params = resolveSamplingParams(testModel("openai-completions"), "off");
    strictEqual(params, undefined);
    const model = {
      ...testModel("openai-completions"),
      reasoning: false,
      samplingParamsByThinkingLevel: { off: { temperature: 1 } },
    };
    deepStrictEqual(resolveSamplingParams(model, "high"), { temperature: 1 });
  });
  it("拒绝不符合声明类型的模型", (): void => {
    throws((): void => {
      resolveSamplingParams(null as unknown as Model, "off");
    }, TypeError);
  });
});

describe("buildBaseOptions", (): void => {
  it("选项透传并按上下文限制输出", (): void => {
    const model = { ...testModel("openai-completions"), contextWindow: 5000 };
    const signal = AbortSignal.abort();
    const options: SimpleStreamOptions = {
      apiKey: "test-key",
      maxTokens: 2000,
      signal,
      sessionId: "session",
      headers: { "x-test": "yes" },
      samplingParams: { top_p: 0.5 },
      maxRetries: 0,
    };
    const result = buildBaseOptions(model, normalizeContext({ messages: [] }), options);
    strictEqual(result.maxTokens, 904);
    strictEqual(result.signal, signal);
    strictEqual(result.apiKey, "test-key");
    strictEqual(result.headers, options.headers);
    deepStrictEqual(result.samplingParams, { top_p: 0.5 });
    strictEqual(result.maxRetries, 0);
  });
  it("模型和请求都未给输出上限时返回 undefined", (): void => {
    const model = testModel("openai-completions");
    delete model.maxTokens;
    const options = buildBaseOptions(model, normalizeContext({ messages: [] }), {
      apiKey: "test-key",
    });
    strictEqual(options.maxTokens, undefined);
  });
  it("缺失必需选项对象时抛出异常", (): void => {
    throws((): void => {
      buildBaseOptions(
        testModel("openai-completions"),
        normalizeContext({ messages: [] }),
        null as unknown as SimpleStreamOptions,
      );
    }, TypeError);
  });
});

describe("thinkingBudgetForLevel", (): void => {
  it("按级别取得默认或自定义预算", (): void => {
    strictEqual(thinkingBudgetForLevel("medium"), 8192);
    strictEqual(thinkingBudgetForLevel("low", { low: 3000 }), 3000);
  });
  it("最大级别使用 high，零预算不被默认值覆盖", (): void => {
    strictEqual(thinkingBudgetForLevel("max"), 16384);
    strictEqual(thinkingBudgetForLevel("xhigh"), 16384);
    strictEqual(thinkingBudgetForLevel("minimal", { minimal: 0 }), 0);
  });
  it("声明类型以外的级别没有对应预算", (): void => {
    strictEqual(thinkingBudgetForLevel("invalid" as ThinkingLevel), undefined);
  });
});

describe("clampThinkingBudgetToAnswerRoom", (): void => {
  it("为答案留下 1024 个 token", (): void => {
    strictEqual(clampThinkingBudgetToAnswerRoom(2000, 3000), 1976);
  });
  it("低于回答余量时返回零，预算小于余量时保留预算", (): void => {
    strictEqual(clampThinkingBudgetToAnswerRoom(100, 1024), 0);
    strictEqual(clampThinkingBudgetToAnswerRoom(100, 2000), 100);
  });
  it("非有限数字不会被隐藏为有效预算", (): void => {
    const budget = clampThinkingBudgetToAnswerRoom(Number.NaN, 2000);
    strictEqual(Number.isNaN(budget), true);
  });
});

describe("adjustMaxTokensForThinking", (): void => {
  it("在调用方回答预算上增加思考预算", (): void => {
    deepStrictEqual(adjustMaxTokensForThinking(1000, 10000, "low"), {
      maxTokens: 3048,
      thinkingBudget: 2048,
    });
  });
  it("缺省使用模型上限，并在预算占满时为回答留空间", (): void => {
    deepStrictEqual(adjustMaxTokensForThinking(undefined, 2000, "high"), {
      maxTokens: 2000,
      thinkingBudget: 976,
    });
    deepStrictEqual(adjustMaxTokensForThinking(0, 1024, "low"), {
      maxTokens: 1024,
      thinkingBudget: 0,
    });
  });
  it("无效级别不会产生有效输出上限", (): void => {
    const adjusted = adjustMaxTokensForThinking(100, 10000, "invalid" as ThinkingLevel);
    strictEqual(Number.isNaN(adjusted.maxTokens), true);
    strictEqual(adjusted.thinkingBudget, undefined);
  });
});

import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import {
  calculateCost,
  getSupportedThinkingLevels,
  clampThinkingLevel,
  modelsAreEqual,
} from "../../src/ai/models.ts";
import type { ModelThinkingLevel } from "../../src/ai/types.ts";
import { model, assistant } from "./helpers.ts";

describe("calculateCost", (): void => {
  it("按百万 token 单价计算并写回费用", (): void => {
    const usage = assistant().usage;
    usage.input = 1000000;
    usage.output = 1000000;
    usage.cacheRead = 1000000;
    usage.cacheWrite = 1000000;
    usage.cacheWrite1h = 250000;
    const result = calculateCost(
      model({ cost: { input: 2, output: 3, cacheRead: 0.5, cacheWrite: 1 } }),
      usage,
    );
    deepStrictEqual(result, { input: 2, output: 3, cacheRead: 0.5, cacheWrite: 1.75, total: 7.25 });
    strictEqual(result, usage.cost);
  });
  it("缺少费率及零用量时费用为零", (): void => {
    const usage = assistant().usage;
    strictEqual(calculateCost(model(), usage).total, 0);
    usage.input = 0;
    usage.output = 0;
    strictEqual(
      calculateCost(model({ cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } }), usage)
        .total,
      0,
    );
  });
  it("阶梯阈值为严格大于且不依赖配置顺序", (): void => {
    const target = model({
      cost: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tiers: [
          { inputTokensAbove: 20, input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
          { inputTokensAbove: 10, input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
        ],
      },
    });
    const usage = assistant().usage;
    usage.input = 10;
    const actual000001 = calculateCost(target, usage).input;
    ok(Math.abs(actual000001 - 0.00001) < 1e-12);
    usage.input = 20;
    const actual000004 = calculateCost(target, usage).input;
    ok(Math.abs(actual000004 - 0.00004) < 1e-12);
    usage.input = 21;
    const actual0000063 = calculateCost(target, usage).input;
    ok(Math.abs(actual0000063 - 0.000063) < 1e-12);
  });
});
describe("推理级别", (): void => {
  it("返回有序支持级别并保留显式扩展级别", (): void => {
    const target = model({
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: null },
    });
    deepStrictEqual(getSupportedThinkingLevels(target), [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    strictEqual(clampThinkingLevel(target, "minimal"), "low");
  });
  it("不支持推理及全部禁用时回退 off", (): void => {
    deepStrictEqual(getSupportedThinkingLevels(model({ reasoning: false })), ["off"]);
    strictEqual(clampThinkingLevel(model({ reasoning: false }), "max"), "off");
    const target = model({
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    });
    deepStrictEqual(getSupportedThinkingLevels(target), []);
    strictEqual(clampThinkingLevel(target, "high"), "off");
  });
  it("未知级别回退第一个支持级别，高于最大支持值向下查找", (): void => {
    strictEqual(clampThinkingLevel(model(), "未知" as ModelThinkingLevel), "off");
    strictEqual(clampThinkingLevel(model(), "max"), "high");
  });
});
describe("modelsAreEqual", (): void => {
  it("按 api、baseUrl、id 比较而不比较展示字段", (): void => {
    strictEqual(modelsAreEqual(model(), model({ name: "另一展示名" })), true);
  });
  it("空模型不会相等", (): void => {
    strictEqual(modelsAreEqual(null, null), false);
    strictEqual(modelsAreEqual(undefined, model()), false);
  });
  it("精确区分大小写及协议和地址", (): void => {
    strictEqual(modelsAreEqual(model(), model({ id: "不同模型" })), false);
    strictEqual(modelsAreEqual(model(), model({ api: "openai-responses" })), false);
    strictEqual(modelsAreEqual(model(), model({ baseUrl: "https://other.test" })), false);
  });
});

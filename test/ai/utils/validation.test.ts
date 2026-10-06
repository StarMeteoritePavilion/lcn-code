import { deepStrictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { validateToolArguments, validateToolCall } from "../../../src/ai/utils/validation.ts";
import type { Tool, ToolCall, JsonObject } from "../../../src/ai/types.ts";
import { tool } from "../helpers.ts";

/**
 * 创建给定参数的工具调用。
 * @param args - 当前检查的参数。
 * @param name - 精确工具名称。
 * @returns 独立工具调用。
 */
function call(args: JsonObject, name: string = "测试工具"): ToolCall {
  return { type: "toolCall", id: "调用", name, arguments: args };
}

describe("validateToolCall", (): void => {
  it("按精确名称选中工具并返回参数副本", (): void => {
    const target = call({ value: 2 });
    deepStrictEqual(validateToolCall([tool()], target), { value: 2 });
    deepStrictEqual(target.arguments, { value: 2 });
  });
  it("数值零合法，空工具集合不允许调用", (): void => {
    deepStrictEqual(validateToolCall([tool()], call({ value: 0 })), { value: 0 });
    throws((): unknown => validateToolCall([], call({ value: 1 })), /not found/);
  });
  it("未知工具名和错误参数明确拒绝", (): void => {
    throws((): unknown => validateToolCall([tool()], call({ value: 1 }, "未知工具")), /not found/);
    throws((): unknown => validateToolCall([tool()], call({})), /value/);
  });
});
describe("validateToolArguments", (): void => {
  it("TypeBox和普通JSON schema均可转换数字参数", (): void => {
    const schema = JSON.parse(JSON.stringify(tool().parameters)) as Tool["parameters"];
    const target = { ...tool(), parameters: schema };
    const input = call({ value: "2" });
    deepStrictEqual(validateToolArguments(target, input), { value: 2 });
    deepStrictEqual(input.arguments, { value: "2" });
    deepStrictEqual(validateToolArguments(tool(), call({ value: "3" })), { value: 3 });
  });
  it("删除不接受null的可选属性，保留显式可空与必填字段", (): void => {
    const target: Tool = {
      ...tool(),
      parameters: Type.Object({
        value: Type.Number(),
        optional: Type.Optional(Type.String()),
        nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
    };
    deepStrictEqual(
      validateToolArguments(target, call({ value: 0, optional: null, nullable: null })),
      { value: 0, nullable: null },
    );
  });
  it("拒绝未知额外字段、缺失必填项及不可转换值", (): void => {
    const cases: JsonObject[] = [{}, { value: "无法转换" }, { value: 1, extra: true }];
    for (const args of cases) {
      throws((): unknown => validateToolArguments(tool(), call(args)), /Validation failed/);
    }
  });
  it("普通schema转换嵌套数组、布尔与联合字段但不修改输入", (): void => {
    const schema = {
      type: "object",
      properties: {
        list: { type: "array", items: { type: "integer" } },
        flag: { type: "boolean" },
        text: { type: "string" },
      },
      required: ["list", "flag", "text"],
    } as Tool["parameters"];
    const target = { ...tool(), parameters: schema };
    const input = call({ list: ["1", "2"], flag: "false", text: 10 });
    deepStrictEqual(validateToolArguments(target, input), {
      list: [1, 2],
      flag: false,
      text: "10",
    });
    deepStrictEqual(input.arguments, { list: ["1", "2"], flag: "false", text: 10 });
  });
});

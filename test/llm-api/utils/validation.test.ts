import { deepStrictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { validateToolArguments, validateToolCall } from "../../../src/llm-api/utils/validation.ts";
import type { Tool, ToolCall, JsonObject, JsonValue } from "../../../src/llm-api/types.ts";
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

describe("validateToolArguments 普通 JSON Schema 分支", (): void => {
  it("保留多类型字段中已经匹配的数字、整数、布尔、字符串、数组、对象和 null", (): void => {
    const schema = {
      type: "object",
      properties: {
        number: { type: ["number", "string"] },
        integer: { type: ["integer", "string"] },
        boolean: { type: ["boolean", "string"] },
        string: { type: ["string", "null"] },
        array: { type: ["array", "null"] },
        object: { type: ["object", "null"] },
        nullable: { type: ["number", "null"] },
      },
    } as Tool["parameters"];
    const args = {
      number: 1.5,
      integer: 1,
      boolean: true,
      string: "文字",
      array: [1],
      object: {},
      nullable: null,
    };
    deepStrictEqual(validateToolArguments({ ...tool(), parameters: schema }, call(args)), args);
  });

  it("转换布尔数字与空值，无法转换的整数和布尔值拒绝校验", (): void => {
    const cases: [string, JsonValue, JsonValue][] = [
      ["number", null, 0],
      ["number", true, 1],
      ["number", false, 0],
      ["integer", null, 0],
      ["integer", true, 1],
      ["integer", false, 0],
      ["boolean", null, false],
      ["boolean", "true", true],
      ["boolean", 1, true],
      ["boolean", 0, false],
      ["string", null, ""],
      ["string", false, "false"],
      ["null", "", null],
      ["null", 0, null],
      ["null", false, null],
    ];
    for (const [type, input, expected] of cases) {
      const parameters = {
        type: "object",
        properties: { value: { type } },
        required: ["value"],
      } as Tool["parameters"];
      deepStrictEqual(validateToolArguments({ ...tool(), parameters }, call({ value: input })), {
        value: expected,
      });
    }
    for (const [type, value] of [
      ["integer", "1.5"],
      ["integer", "文字"],
      ["boolean", 2],
      ["boolean", "文字"],
      ["number", " "],
      ["null", 2],
    ] as const) {
      const parameters = {
        type: "object",
        properties: { value: { type } },
        required: ["value"],
      } as Tool["parameters"];
      throws(
        (): unknown => validateToolArguments({ ...tool(), parameters }, call({ value })),
        /Validation failed/,
      );
    }
  });

  it("依次转换 allOf、oneOf、anyOf 和额外属性，联合匹配时保留原值", (): void => {
    const parameters = {
      type: "object",
      properties: {
        all: { allOf: [{ type: "number" }, { minimum: 1 }] },
        one: { oneOf: [{ type: "integer" }, { type: "boolean" }] },
        any: { anyOf: [{ type: "integer" }, { type: "boolean" }] },
        unchanged: { anyOf: [{ type: "string" }, { type: "boolean" }] },
      },
      additionalProperties: { type: "integer" },
    } as Tool["parameters"];
    const args = { all: "2", one: "3", any: "false", unchanged: "文字", extra: "4" };
    deepStrictEqual(validateToolArguments({ ...tool(), parameters }, call(args)), {
      all: 2,
      one: 3,
      any: false,
      unchanged: "文字",
      extra: 4,
    });
    deepStrictEqual(args, { all: "2", one: "3", any: "false", unchanged: "文字", extra: "4" });
    throws(
      (): unknown => validateToolArguments({ ...tool(), parameters }, call({ one: {} })),
      /Validation failed/,
    );
  });

  it("元组逐位置转换与清理可选 null，超出 items 的值保留", (): void => {
    const parameters = {
      type: "object",
      properties: {
        tuple: {
          type: "array",
          items: [
            { type: "integer" },
            { type: "object", properties: { optional: { type: "string" } } },
          ],
        },
        untyped: {},
        map: { type: "object", additionalProperties: { type: "boolean" } },
      },
    } as Tool["parameters"];
    const input = call({
      tuple: ["2", { optional: null }, "额外"],
      untyped: "原值",
      map: { enabled: "true" },
    });
    deepStrictEqual(validateToolArguments({ ...tool(), parameters }, input), {
      tuple: [2, {}, "额外"],
      untyped: "原值",
      map: { enabled: true },
    });
    deepStrictEqual(input.arguments.tuple, ["2", { optional: null }, "额外"]);
  });

  it("嵌套缺少必填字段时报告完整属性路径", (): void => {
    const parameters = Type.Object({ nested: Type.Object({ value: Type.Number() }) });
    throws(
      (): unknown => validateToolArguments({ ...tool(), parameters }, call({ nested: {} })),
      /nested.value/,
    );
  });
});

describe("validateToolArguments 联合对象替换", (): void => {
  it("根对象联合转换后的副本替换原字段且不修改调用参数", (): void => {
    const parameters = {
      anyOf: [{ type: "object", properties: { value: { type: "integer" } }, required: ["value"] }],
    } as Tool["parameters"];
    const input = call({ value: "2" });
    deepStrictEqual(validateToolArguments({ ...tool(), parameters }, input), { value: 2 });
    deepStrictEqual(input.arguments, { value: "2" });
  });

  it("普通字符串类型接受现有字符串且拒绝对象", (): void => {
    const parameters = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    } as Tool["parameters"];
    deepStrictEqual(validateToolArguments({ ...tool(), parameters }, call({ value: "文字" })), {
      value: "文字",
    });
    throws(
      (): unknown => validateToolArguments({ ...tool(), parameters }, call({ value: {} })),
      /Validation failed/,
    );
  });

  it("根 Schema 的定义引用可验证，但无法独立编译的联合子 Schema 保持原值", (): void => {
    const parameters = {
      $defs: { text: { type: "string" } },
      type: "object",
      properties: { value: { anyOf: [{ $ref: "#/$defs/text" }, { type: "integer" }] } },
    } as Tool["parameters"];
    deepStrictEqual(validateToolArguments({ ...tool(), parameters }, call({ value: "文字" })), {
      value: "文字",
    });
    deepStrictEqual(validateToolArguments({ ...tool(), parameters }, call({ value: "2" })), {
      value: 2,
    });
  });
});

describe("validateToolArguments 根值转换", (): void => {
  it("外部传入根原始值时返回转换结果，转换后校验失败时保留原值", (): void => {
    const parameters = { type: "integer", minimum: 2 } as Tool["parameters"];
    const target = { ...tool(), parameters };
    const validCall = { ...call({}), arguments: "2" } as unknown as ToolCall;
    const invalidCall = { ...call({}), arguments: "1" } as unknown as ToolCall;
    deepStrictEqual(validateToolArguments(target, validCall), 2);
    deepStrictEqual(validateToolArguments(target, invalidCall), "1");
    deepStrictEqual(validCall.arguments, "2");
  });
});

describe("validateToolArguments 未识别 JSON Schema 类型", (): void => {
  it("编译器宽松接受未识别类型时，不把原始值转换成该类型", (): void => {
    const parameters = {
      type: "object",
      properties: { value: { type: ["未识别类型", "integer"] } },
    } as Tool["parameters"];
    deepStrictEqual(validateToolArguments({ ...tool(), parameters }, call({ value: {} })), {
      value: {},
    });
  });
});

describe("validateToolArguments 无效 Schema", (): void => {
  it("可选 null 字段的子 Schema 无法编译时保留输入并透传最终编译错误", (): void => {
    const parameters = {
      type: "object",
      properties: { value: { type: "string", pattern: "[" } },
    } as Tool["parameters"];
    const input = call({ value: null });
    throws((): unknown => validateToolArguments({ ...tool(), parameters }, input), SyntaxError);
    deepStrictEqual(input.arguments, { value: null });
  });
});

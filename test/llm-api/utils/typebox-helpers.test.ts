import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { Compile } from "typebox/compile";
import { stringEnum } from "../../../src/llm-api/utils/typebox-helpers.ts";

describe("stringEnum", (): void => {
  it("输出字符串枚举并供TypeBox校验", (): void => {
    const schema = stringEnum(["一", "二"] as const, { description: "说明", default: "一" });
    const validator = Compile(schema);
    strictEqual(validator.Check("一"), true);
    strictEqual(Reflect.get(schema, "description"), "说明");
    strictEqual(Reflect.get(schema, "default"), "一");
  });
  it("空枚举无允许值，空默认说明不写入", (): void => {
    const schema = stringEnum([], { description: "" });
    deepStrictEqual(Reflect.get(schema, "enum"), []);
    strictEqual(Reflect.get(schema, "description"), undefined);
    const empty = stringEnum([""] as const, { default: "" });
    strictEqual(Reflect.get(empty, "default"), undefined);
  });
  it("枚举校验拒绝未知字符串与非字符串", (): void => {
    const validator = Compile(stringEnum(["A"]));
    strictEqual(validator.Check("a"), false);
    strictEqual(validator.Check(1), false);
  });
});

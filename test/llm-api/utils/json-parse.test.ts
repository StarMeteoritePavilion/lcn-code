import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  repairJson,
  parseJsonWithRepair,
  parseStreamingJson,
} from "../../../src/llm-api/utils/json-parse.ts";

describe("repairJson", (): void => {
  it("保留合法转义和字符串外的结构", (): void => {
    const text = '{"value":"\\u4e2d\\n\\\\"}';
    strictEqual(repairJson(text), text);
  });
  it("空字符串原样返回，尾部反斜杠被转义", (): void => {
    strictEqual(repairJson(""), "");
    strictEqual(repairJson('"a\\'), '"a\\\\');
  });
  it("修复原始控制字符、未知转义和无效 Unicode 转义", (): void => {
    const value = "换行\n\t\r\b\f\u0001";
    deepStrictEqual(parseJsonWithRepair(`{"value":"${value}"}`), { value });
    deepStrictEqual(parseJsonWithRepair('{"value":"\\q\\uXXXX"}'), { value: "\\q\\uXXXX" });
  });
});
describe("parseJsonWithRepair", (): void => {
  it("解析合法对象和基本值", (): void => {
    deepStrictEqual(parseJsonWithRepair('{"a":1}'), { a: 1 });
    strictEqual(parseJsonWithRepair("null"), null);
  });
  it("可修复控制字符时返回修复结果", (): void => {
    strictEqual(parseJsonWithRepair('"a\nb"'), "a\nb");
  });
  it("空文本及不可修复结构抛出 SyntaxError", (): void => {
    throws((): unknown => parseJsonWithRepair(""), SyntaxError);
    throws((): unknown => parseJsonWithRepair('{"a":'), SyntaxError);
    throws((): unknown => parseJsonWithRepair('"\n'), SyntaxError);
  });
});
describe("parseStreamingJson", (): void => {
  it("解析完整 JSON 与部分对象", (): void => {
    deepStrictEqual(parseStreamingJson('{"a":1}'), { a: 1 });
    deepStrictEqual(parseStreamingJson('{"a":1,"b":'), { a: 1 });
  });
  it("缺失、空白和 null 返回空对象", (): void => {
    for (const value of [undefined, "", " ", "null"]) {
      deepStrictEqual(parseStreamingJson(value), {});
    }
  });
  it("错误输入和部分非法字符串安全回退空对象", (): void => {
    deepStrictEqual(parseStreamingJson("不是JSON"), {});
    deepStrictEqual(parseStreamingJson('{"a":"x\ny"'), {});
  });
});

describe("流式JSON部分基本值", (): void => {
  it("部分null回退空对象，顶层非法控制字符修复后保留部分文本", (): void => {
    deepStrictEqual(parseStreamingJson("nul"), {});
    strictEqual(parseStreamingJson('"a\nb'), "a\nb");
    strictEqual(parseStreamingJson('"\u0001'), "\u0001");
  });
});

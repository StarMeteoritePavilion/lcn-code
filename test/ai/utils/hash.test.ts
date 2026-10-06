import { strictEqual, notStrictEqual, match, throws } from "node:assert";
import { describe, it } from "node:test";
import { shortHash } from "../../../src/ai/utils/hash.ts";

describe("shortHash", (): void => {
  it("相同字符串哈希确定，大小写不同保留差异", (): void => {
    strictEqual(shortHash("测试文本"), shortHash("测试文本"));
    notStrictEqual(shortHash("A"), shortHash("a"));
  });
  it("空文本和代理字符可哈希为36进制串", (): void => {
    match(shortHash(""), /^[0-9a-z]+$/);
    match(shortHash("\ud800"), /^[0-9a-z]+$/);
  });
  it("非字符串输入不会被悄悄转换为字符串", (): void => {
    throws((): string => shortHash(null as unknown as string), TypeError);
  });
});

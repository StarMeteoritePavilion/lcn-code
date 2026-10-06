import { strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { sanitizeSurrogates } from "../../../src/ai/utils/sanitize-unicode.ts";

describe("sanitizeSurrogates", (): void => {
  it("保留中文与完整代理对", (): void => {
    strictEqual(sanitizeSurrogates("中文🙈"), "中文🙈");
  });
  it("空文本原样返回，连续代理仅保留配对部分", (): void => {
    strictEqual(sanitizeSurrogates(""), "");
    strictEqual(sanitizeSurrogates("\ud800\ud800\udc00\udc00"), "\ud800\udc00");
  });
  it("删除孤立高低代理，错误类型拒绝", (): void => {
    strictEqual(sanitizeSurrogates("a\ud800b\udc00c"), "abc");
    throws((): string => sanitizeSurrogates(null as unknown as string), TypeError);
  });
});

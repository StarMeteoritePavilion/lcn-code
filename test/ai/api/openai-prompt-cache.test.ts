import { strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { clampOpenAIPromptCacheKey } from "../../../src/ai/api/openai-prompt-cache.ts";

describe("clampOpenAIPromptCacheKey", (): void => {
  it("保留普通缓存键", (): void => {
    strictEqual(clampOpenAIPromptCacheKey("session-测试"), "session-测试");
  });
  it("保留缺省、空键和恰好 64 个码点的键", (): void => {
    strictEqual(clampOpenAIPromptCacheKey(undefined), undefined);
    strictEqual(clampOpenAIPromptCacheKey(""), "");
    const key = "😀".repeat(64);
    strictEqual(clampOpenAIPromptCacheKey(key), key);
  });
  it("过长键按码点截断且不拆开代理对", (): void => {
    const key = "😀".repeat(65);
    const expected = "😀".repeat(64);
    strictEqual(clampOpenAIPromptCacheKey(key), expected);
  });
  it("不符合声明类型的 null 键抛出异常", (): void => {
    throws((): void => {
      clampOpenAIPromptCacheKey(null as unknown as string);
    }, TypeError);
  });
});

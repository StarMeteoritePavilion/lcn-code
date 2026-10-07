import { strictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import {
  isContextOverflow,
  isRecoverableLength,
  getOverflowPatterns,
} from "../../../src/llm-api/utils/overflow.ts";
import { assistant } from "../helpers.ts";

describe("isContextOverflow", (): void => {
  it("识别错误信息及静默超出窗口", (): void => {
    strictEqual(
      isContextOverflow(assistant({ stopReason: "error", errorMessage: "prompt is too long" })),
      true,
    );
    strictEqual(isContextOverflow(assistant(), 9), true);
    strictEqual(isContextOverflow(assistant(), 10), false);
  });
  it("零输出长度停止在窗口99%处识别溢出", (): void => {
    const message = assistant({ stopReason: "length" });
    message.usage.input = 99;
    message.usage.output = 0;
    strictEqual(isContextOverflow(message, 100), true);
    message.usage.input = 98;
    strictEqual(isContextOverflow(message, 100), false);
    strictEqual(isContextOverflow(message), false);
  });
  it("限流和其他异常不会误报溢出", (): void => {
    strictEqual(
      isContextOverflow(
        assistant({ stopReason: "error", errorMessage: "rate limit: too many tokens" }),
      ),
      false,
    );
    strictEqual(
      isContextOverflow(assistant({ stopReason: "error", errorMessage: "网络异常" })),
      false,
    );
    strictEqual(isContextOverflow(assistant({ stopReason: "aborted" }), 1), false);
  });
});
describe("isRecoverableLength", (): void => {
  it("长度停止且低于预期输出上限时可恢复", (): void => {
    strictEqual(isRecoverableLength(assistant({ stopReason: "length" }), 3), true);
  });
  it("等于上限或零上限不可恢复", (): void => {
    strictEqual(isRecoverableLength(assistant({ stopReason: "length" }), 2), false);
    strictEqual(isRecoverableLength(assistant({ stopReason: "length" }), 0), false);
  });
  it("错误停止和负数上限不可恢复", (): void => {
    strictEqual(isRecoverableLength(assistant({ stopReason: "error" }), 10), false);
    strictEqual(isRecoverableLength(assistant({ stopReason: "length" }), -1), false);
  });
});
describe("getOverflowPatterns", (): void => {
  it("返回能识别已有错误示例的正则", (): void => {
    ok(
      getOverflowPatterns().some((pattern: RegExp): boolean =>
        pattern.test("context_length_exceeded"),
      ),
    );
  });
  it("每次调用返回独立数组", (): void => {
    const patterns = getOverflowPatterns();
    const count = patterns.length;
    patterns.length = 0;
    strictEqual(getOverflowPatterns().length, count);
  });
  it("普通异常文本不会被识别", (): void => {
    strictEqual(
      getOverflowPatterns().some((pattern: RegExp): boolean =>
        pattern.test("authentication failed"),
      ),
      false,
    );
  });
});

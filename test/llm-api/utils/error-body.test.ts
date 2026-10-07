import { deepStrictEqual, strictEqual, match } from "node:assert";
import { describe, it } from "node:test";
import {
  normalizeProviderError,
  formatProviderError,
} from "../../../src/llm-api/utils/error-body.ts";

describe("normalizeProviderError", (): void => {
  it("按SDK字段优先级提取状态与响应体", (): void => {
    const error = Object.assign(new Error("请求失败"), {
      statusCode: 403,
      status: 500,
      body: " 原因 ",
    });
    deepStrictEqual(normalizeProviderError(error), {
      status: 403,
      body: "原因",
      message: "请求失败",
      hasMessageBody: false,
    });
    const openai = Object.assign(new Error("失败"), { status: 400, error: { message: "错误" } });
    strictEqual(normalizeProviderError(openai).body, '{"message":"错误"}');
    const bedrock = Object.assign(new Error("失败"), {
      $metadata: { httpStatusCode: 500 },
      $response: { body: { error: "错误" } },
    });
    strictEqual(normalizeProviderError(bedrock).status, 500);
    strictEqual(normalizeProviderError(bedrock).body, '{"error":"错误"}');
  });
  it("空响应和已包含响应体时不重复输出，长响应裁剪", (): void => {
    strictEqual(
      normalizeProviderError(Object.assign(new Error("原因"), { body: "原因" })).hasMessageBody,
      true,
    );
    strictEqual(
      normalizeProviderError(Object.assign(new Error("失败"), { body: " " })).body,
      undefined,
    );
    const long = normalizeProviderError(
      Object.assign(new Error("失败"), { body: "x".repeat(4001) }),
    );
    match(long.body ?? "", /\[truncated 1 chars\]$/);
  });
  it("非Error、循环对象、空对象和未读取流不丢失错误消息", (): void => {
    deepStrictEqual(normalizeProviderError(null), { message: "null", hasMessageBody: false });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    strictEqual(normalizeProviderError(cyclic).message, "[object Object]");
    for (const body of [{}, { pipe: (): void => {} }, new ReadableStream()]) {
      const error = Object.assign(new Error("原始失败"), { $response: { statusCode: 502, body } });
      strictEqual(normalizeProviderError(error).body, undefined);
      strictEqual(normalizeProviderError(error).message, "原始失败");
    }
  });
});
describe("formatProviderError", (): void => {
  it("组合状态、响应与提供方前缀", (): void => {
    const norm = { status: 403, body: "拒绝", message: "请求失败", hasMessageBody: false };
    strictEqual(formatProviderError(norm), "403: 拒绝");
    strictEqual(formatProviderError(norm, "服务"), "服务 (403): 拒绝");
  });
  it("已包含响应体或缺少状态时保留原消息", (): void => {
    strictEqual(
      formatProviderError({
        status: 400,
        body: "拒绝",
        message: "400: 拒绝",
        hasMessageBody: true,
      }),
      "400: 拒绝",
    );
    strictEqual(formatProviderError({ message: "失败", hasMessageBody: false }, "服务"), "失败");
  });
  it("缺失响应体的异常保留状态及原始错误", (): void => {
    strictEqual(
      formatProviderError({ status: 500, message: "错误", hasMessageBody: false }, "服务"),
      "服务 (500): 错误",
    );
  });
});

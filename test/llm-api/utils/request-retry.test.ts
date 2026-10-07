import { strictEqual, rejects } from "node:assert";
import { describe, it } from "node:test";
import { retryRequest } from "../../../src/llm-api/utils/request-retry.ts";

describe("retryRequest", (): void => {
  it("请求成功原样返回，可重试状态在零延迟后成功", async (): Promise<void> => {
    strictEqual(await retryRequest(async (): Promise<number> => 42), 42);
    for (const status of [undefined, 408, 409, 429, 500]) {
      let calls = 0;
      const value = await retryRequest(
        async (): Promise<string> => {
          calls++;
          if (calls === 1) {
            throw Object.assign(new Error("瞬时失败"), {
              status,
              headers: new Headers({ "retry-after-ms": "0" }),
            });
          }
          return "成功";
        },
        { maxRetries: 1 },
      );
      strictEqual(value, "成功");
      strictEqual(calls, 2);
    }
  });
  it("默认零预算、不可重试状态和明确禁止重试均不重试", async (): Promise<void> => {
    const cases = [
      { status: 500, headers: new Headers(), options: {} },
      { status: 400, headers: new Headers(), options: { maxRetries: 1 } },
      {
        status: 503,
        headers: new Headers({ "x-should-retry": "false" }),
        options: { maxRetries: 1 },
      },
    ];
    for (const item of cases) {
      const error = Object.assign(new Error("失败"), {
        status: item.status,
        headers: item.headers,
      });
      let calls = 0;
      await rejects(
        retryRequest(async (): Promise<void> => {
          calls++;
          throw error;
        }, item.options),
        (value: unknown): boolean => value === error,
      );
      strictEqual(calls, 1);
    }
  });
  it("非SDK异常和耗尽错误原样拒绝，超上限延迟不等待", async (): Promise<void> => {
    const error = new Error("非SDK异常");
    await rejects(
      retryRequest(
        async (): Promise<void> => {
          throw error;
        },
        { maxRetries: 1 },
      ),
      (value: unknown): boolean => value === error,
    );
    const capped = Object.assign(new Error("服务失败"), {
      status: 429,
      headers: new Headers({ "retry-after": "61" }),
    });
    await rejects(
      retryRequest(
        async (): Promise<void> => {
          throw capped;
        },
        { maxRetries: 1 },
      ),
      /Server requested 61s retry delay/,
    );
  });
  it("显式允许重试覆盖状态，retry-after秒数及负延迟可消费", async (): Promise<void> => {
    let calls = 0;
    const value = await retryRequest(
      async (): Promise<number> => {
        calls++;
        if (calls === 1) {
          throw Object.assign(new Error("失败"), {
            status: 400,
            headers: new Headers({ "x-should-retry": "true", "retry-after": "-1" }),
          });
        }
        return 1;
      },
      { maxRetries: 1 },
    );
    strictEqual(value, 1);
  });
  it("退避等待中断后停止请求，已中断失败转成AbortError", async (): Promise<void> => {
    const controller = new AbortController();
    let calls = 0;
    const promise = retryRequest(
      async (): Promise<void> => {
        calls++;
        throw Object.assign(new Error("失败"), {
          status: 503,
          headers: new Headers({ "retry-after-ms": "1000" }),
        });
      },
      { maxRetries: 1, signal: controller.signal },
    );
    queueMicrotask((): void => controller.abort());
    await rejects(promise, { name: "AbortError" });
    strictEqual(calls, 1);
  });
});

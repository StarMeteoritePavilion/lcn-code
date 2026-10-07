import { strictEqual, rejects } from "node:assert";
import { getEventListeners } from "node:events";
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

describe("retryRequest 延迟与取消边界", (): void => {
  it("HTTP日期及无效毫秒头回退秒头，零上限不限制服务端延迟", async (): Promise<void> => {
    const cases = [
      {
        headers: new Headers({ "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" }),
        maxRetryDelayMs: undefined,
      },
      {
        headers: new Headers({ "retry-after-ms": "invalid", "retry-after": "0" }),
        maxRetryDelayMs: 0,
      },
    ];
    for (const item of cases) {
      let calls = 0;
      const result = await retryRequest(
        async (): Promise<number> => {
          calls++;
          if (calls === 1) {
            throw Object.assign(new Error("暂时失败"), { status: 503, headers: item.headers });
          }
          return calls;
        },
        { maxRetries: 1, maxRetryDelayMs: item.maxRetryDelayMs },
      );
      strictEqual(result, 2);
    }
  });
  it("缺少响应头或非法延迟头采用指数退避，耗尽后保留最后异常", async (): Promise<void> => {
    for (const headers of [
      undefined,
      new Headers({ "retry-after-ms": "Infinity", "retry-after": "invalid" }),
    ]) {
      const error = Object.assign(new Error("持续失败"), { status: undefined, headers });
      let calls = 0;
      await rejects(
        retryRequest(
          async (): Promise<void> => {
            calls++;
            throw error;
          },
          { maxRetries: 1 },
        ),
        (value: unknown): boolean => value === error,
      );
      strictEqual(calls, 2);
    }
  });
  it("错误字段类型及非Error值不进入重试", async (): Promise<void> => {
    for (const error of [
      "失败",
      Object.assign(new Error("状态错误"), { status: "503", headers: undefined }),
      Object.assign(new Error("头错误"), { status: 503, headers: {} }),
    ]) {
      let calls = 0;
      await rejects(
        retryRequest(
          async (): Promise<void> => {
            calls++;
            throw error;
          },
          { maxRetries: 1 },
        ),
        (value: unknown): boolean => value === error,
      );
      strictEqual(calls, 1);
    }
  });
  it("已中断的请求失败与已注册的退避取消都返回AbortError", async (): Promise<void> => {
    const controller = new AbortController();
    let calls = 0;
    const running = retryRequest(
      async (): Promise<void> => {
        calls++;
        setImmediate((): void => controller.abort());
        throw Object.assign(new Error("暂时失败"), {
          status: 503,
          headers: new Headers({ "retry-after-ms": "1000" }),
        });
      },
      { maxRetries: 1, signal: controller.signal },
    );
    await rejects(running, { name: "AbortError" });
    strictEqual(calls, 1);
    await rejects(
      retryRequest(
        async (): Promise<void> => {
          throw new Error("调用失败");
        },
        { signal: AbortSignal.abort() },
      ),
      { name: "AbortError" },
    );
  });
});

describe("retryRequest 元数据读取期间的取消", (): void => {
  it("延迟响应头读取时取消，退避不会注册新的等待", async (): Promise<void> => {
    const controller = new AbortController();
    class AbortHeaders extends Headers {
      /**
       * 在读取服务端延迟时取消当前请求。
       * @param name - 请求头名称。
       * @returns 读取到的原始请求头值。
       */
      override get(name: string): string | null {
        if (name === "retry-after-ms") {
          controller.abort();
        }
        return super.get(name);
      }
    }
    const headers = new AbortHeaders({ "retry-after-ms": "0" });
    let calls = 0;
    await rejects(
      retryRequest(
        async (): Promise<void> => {
          calls++;
          throw Object.assign(new Error("暂时失败"), { status: 503, headers });
        },
        { maxRetries: 1, signal: controller.signal },
      ),
      { name: "AbortError" },
    );
    strictEqual(calls, 1);
    strictEqual(getEventListeners(controller.signal, "abort").length, 0);
  });
  it("有信号的正常重试完成后移除退避取消监听器", async (): Promise<void> => {
    const controller = new AbortController();
    let calls = 0;
    const result = await retryRequest(
      async (): Promise<string> => {
        calls++;
        if (calls === 1) {
          throw Object.assign(new Error("暂时失败"), {
            status: 503,
            headers: new Headers({ "retry-after-ms": "0" }),
          });
        }
        return "完成";
      },
      { maxRetries: 1, signal: controller.signal },
    );
    strictEqual(result, "完成");
    strictEqual(getEventListeners(controller.signal, "abort").length, 0);
  });
});

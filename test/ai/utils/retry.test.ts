import { strictEqual, deepStrictEqual, rejects } from "node:assert";
import { describe, it } from "node:test";
import {
  retryDelayMs,
  retryAssistantCall,
  isRetryableAssistantError,
} from "../../../src/ai/utils/retry.ts";
import type { AssistantMessage } from "../../../src/ai/types.ts";
import { assistant } from "../helpers.ts";

describe("retryDelayMs", (): void => {
  it("按指数退避并使用默认上限", (): void => {
    strictEqual(retryDelayMs({ baseDelayMs: 1000 }, 3), 4000);
    strictEqual(retryDelayMs({ baseDelayMs: 1000 }, 100), 60000);
  });
  it("零序号按首次处理，零上限不等待", (): void => {
    strictEqual(retryDelayMs({ baseDelayMs: 10 }, 0), 10);
    strictEqual(retryDelayMs({ baseDelayMs: 10, maxAgentDelayMs: 0 }, 2), 0);
  });
  it("溢出数值收紧到安全整数和指定上限", (): void => {
    strictEqual(retryDelayMs({ baseDelayMs: Infinity, maxAgentDelayMs: 20 }, 2), 20);
  });
});
describe("isRetryableAssistantError", (): void => {
  it("识别网络、限流及提前结束错误", (): void => {
    for (const text of ["network error", "429", "stream ended before message_stop"]) {
      strictEqual(
        isRetryableAssistantError(assistant({ stopReason: "error", errorMessage: text })),
        true,
      );
    }
  });
  it("非错误状态及空错误不重试", (): void => {
    strictEqual(isRetryableAssistantError(assistant()), false);
    strictEqual(
      isRetryableAssistantError(assistant({ stopReason: "error", errorMessage: "" })),
      false,
    );
  });
  it("额度与订阅耗尽优先于429判断", (): void => {
    strictEqual(
      isRetryableAssistantError(
        assistant({ stopReason: "error", errorMessage: "429 insufficient_quota" }),
      ),
      false,
    );
    strictEqual(
      isRetryableAssistantError(
        assistant({ stopReason: "error", errorMessage: "authentication failed" }),
      ),
      false,
    );
  });
});
describe("retryAssistantCall", (): void => {
  it("可重试错误后成功并按顺序通知回调", async (): Promise<void> => {
    let calls = 0;
    const events: string[] = [];
    const result = await retryAssistantCall(
      async (): Promise<AssistantMessage> => {
        calls++;
        return calls === 1 ? assistant({ stopReason: "error", errorMessage: "503" }) : assistant();
      },
      { enabled: true, maxRetries: 1, baseDelayMs: 0 },
      undefined,
      {
        onRetryScheduled: (attempt: number, maximum: number, delay: number): void => {
          strictEqual(attempt, 1);
          strictEqual(maximum, 1);
          strictEqual(delay, 0);
          events.push("安排");
        },
        onRetryAttemptStart: (): void => {
          events.push("开始");
        },
        onRetryFinished: (success: boolean): void => {
          strictEqual(success, true);
          events.push("完成");
        },
      },
    );
    strictEqual(result.stopReason, "stop");
    strictEqual(calls, 2);
    deepStrictEqual(events, ["安排", "开始", "完成"]);
  });
  it("禁用和零预算不重试，耗尽返回最后错误", async (): Promise<void> => {
    for (const policy of [
      undefined,
      { enabled: false, maxRetries: 2, baseDelayMs: 0 },
      { enabled: true, maxRetries: 0, baseDelayMs: 0 },
    ]) {
      let calls = 0;
      const result = await retryAssistantCall(
        async (): Promise<AssistantMessage> => {
          calls++;
          return assistant({ stopReason: "error", errorMessage: "503" });
        },
        policy,
        undefined,
      );
      strictEqual(calls, 1);
      strictEqual(result.stopReason, "error");
    }
    let calls = 0;
    await retryAssistantCall(
      async (): Promise<AssistantMessage> => {
        calls++;
        return assistant({ stopReason: "error", errorMessage: "503" });
      },
      { enabled: true, maxRetries: 1, baseDelayMs: 0 },
      undefined,
      {
        onRetryFinished: (success: boolean, attempt: number): void => {
          strictEqual(success, false);
          strictEqual(attempt, 1);
        },
      },
    );
    strictEqual(calls, 2);
  });
  it("额度错误直接返回，produce和回调抛错原样传播", async (): Promise<void> => {
    let calls = 0;
    const policy = { enabled: true, maxRetries: 2, baseDelayMs: 0 };
    await retryAssistantCall(
      async (): Promise<AssistantMessage> => {
        calls++;
        return assistant({ stopReason: "error", errorMessage: "insufficient_quota" });
      },
      policy,
      undefined,
    );
    strictEqual(calls, 1);
    await rejects(
      retryAssistantCall(
        async (): Promise<AssistantMessage> => {
          throw new Error("调用异常");
        },
        policy,
        undefined,
      ),
      /调用异常/,
    );
    await rejects(
      retryAssistantCall(
        async (): Promise<AssistantMessage> =>
          assistant({ stopReason: "error", errorMessage: "503" }),
        policy,
        undefined,
        {
          onRetryScheduled: (): void => {
            throw new Error("回调异常");
          },
        },
      ),
      /回调异常/,
    );
  });
  it("退避期间中断不再发起调用，并清除错误消息", async (): Promise<void> => {
    const controller = new AbortController();
    let calls = 0;
    const result = await retryAssistantCall(
      async (): Promise<AssistantMessage> => {
        calls++;
        return assistant({ stopReason: "error", errorMessage: "503" });
      },
      { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
      controller.signal,
      {
        onRetryScheduled: (): void => {
          controller.abort();
        },
      },
    );
    strictEqual(calls, 1);
    strictEqual(result.stopReason, "aborted");
    strictEqual(result.errorMessage, undefined);
  });
  it("重试响应已中断时回调报告失败", async (): Promise<void> => {
    let calls = 0;
    let finished = false;
    const result = await retryAssistantCall(
      async (): Promise<AssistantMessage> => {
        calls++;
        return assistant(
          calls === 1 ? { stopReason: "error", errorMessage: "503" } : { stopReason: "aborted" },
        );
      },
      { enabled: true, maxRetries: 1, baseDelayMs: 0 },
      undefined,
      {
        onRetryFinished: (success: boolean): void => {
          finished = true;
          strictEqual(success, false);
        },
      },
    );
    strictEqual(result.stopReason, "aborted");
    strictEqual(finished, true);
  });
});

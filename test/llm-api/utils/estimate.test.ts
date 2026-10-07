import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  estimateMessageTokens,
  estimateContextTokens,
} from "../../../src/llm-api/utils/estimate.ts";
import type { Message, JsonObject } from "../../../src/llm-api/types.ts";
import { assistant, tool } from "../helpers.ts";

describe("estimateMessageTokens", (): void => {
  it("文本按四字符估算，图片按1200 token估算", (): void => {
    strictEqual(estimateMessageTokens({ role: "user", content: "12345", timestamp: 0 }), 2);
    strictEqual(
      estimateMessageTokens({
        role: "user",
        content: [
          { type: "text", text: "1234" },
          { type: "image", data: "", mimeType: "image/jpeg" },
        ],
        timestamp: 0,
      }),
      1201,
    );
    const message = assistant({
      content: [
        { type: "text", text: "1234" },
        { type: "thinking", thinking: "1234" },
        { type: "toolCall", id: "调用", name: "abcd", arguments: {} },
      ],
    });
    strictEqual(estimateMessageTokens(message), 4);
  });
  it("空消息为零，系统工具和工具结果纳入估算", (): void => {
    strictEqual(estimateMessageTokens({ role: "user", content: [], timestamp: 0 }), 0);
    const target = tool();
    const serialized = JSON.stringify([target]);
    strictEqual(
      estimateMessageTokens({
        role: "system",
        content: "1234",
        toolsAdded: [target],
        timestamp: 0,
      }),
      1 + Math.ceil(serialized.length / 4),
    );
    strictEqual(
      estimateMessageTokens({
        role: "toolResult",
        toolCallId: "调用",
        toolName: "工具",
        content: [{ type: "text", text: "12345" }],
        isError: false,
        timestamp: 0,
      }),
      2,
    );
  });
  it("不可序列化的参数采用固定替代文本", (): void => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const message = assistant({
      content: [{ type: "toolCall", id: "调用", name: "abcd", arguments: cyclic as JsonObject }],
    });
    strictEqual(estimateMessageTokens(message), Math.ceil((4 + "[unserializable]".length) / 4));
  });
});
describe("estimateContextTokens", (): void => {
  it("最近有效用量加后续估算，并接受上下文对象", (): void => {
    const messages: Message[] = [assistant(), { role: "user", content: "12345", timestamp: 2 }];
    deepStrictEqual(estimateContextTokens(messages), {
      tokens: 14,
      usageTokens: 12,
      trailingTokens: 2,
      lastUsageIndex: 0,
    });
  });
  it("空数组为零，零totalTokens采用各用量之和", (): void => {
    deepStrictEqual(estimateContextTokens([]), {
      tokens: 0,
      usageTokens: 0,
      trailingTokens: 0,
      lastUsageIndex: null,
    });
    const message = assistant();
    message.usage.totalTokens = 0;
    message.usage.cacheRead = 3;
    strictEqual(estimateContextTokens([message]).usageTokens, 15);
  });
  it("错误、中断及插入更新前缀后的旧用量不能作为基准", (): void => {
    for (const stopReason of ["error", "aborted"] as const) {
      const message = assistant({ stopReason, content: [{ type: "text", text: "1234" }] });
      deepStrictEqual(estimateContextTokens([message]), {
        tokens: 1,
        usageTokens: 0,
        trailingTokens: 1,
        lastUsageIndex: null,
      });
    }
    const messages: Message[] = [
      { role: "system", content: "1234", timestamp: 10 },
      assistant({ timestamp: 1, content: [] }),
    ];
    strictEqual(estimateContextTokens(messages).lastUsageIndex, null);
  });
});

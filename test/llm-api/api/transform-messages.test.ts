import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { transformMessages } from "../../../src/llm-api/api/transform-messages.ts";
import type { AssistantMessage, Message, Model } from "../../../src/llm-api/types.ts";
import { testModel } from "../fixtures.ts";

/**
 * 创建带独立用量对象的助手历史消息。
 * @returns 跨模型的工具调用历史。
 */
function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    baseUrl: "https://other.test",
    model: "other",
    content: [{ type: "toolCall", id: "original", name: "echo", arguments: {} }],
    stopReason: "toolUse",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("transformMessages", (): void => {
  it("跨模型统一工具 ID 并同步更新结果引用", (): void => {
    const assistant = assistantMessage();
    const messages: Message[] = [
      assistant,
      {
        role: "toolResult",
        toolCallId: "original",
        toolName: "echo",
        content: [{ type: "text", text: "结果" }],
        isError: false,
        timestamp: 0,
      },
    ];
    const result = transformMessages(
      messages,
      testModel("openai-completions"),
      (id: string): string => `${id}_normalized`,
    );
    const first = result[0];
    const second = result[1];
    strictEqual(first?.role, "assistant");
    ok(first?.role === "assistant");
    ok(first.content[0]?.type === "toolCall");
    strictEqual(first.content[0].id, "original_normalized");
    strictEqual(second?.role, "toolResult");
    ok(second?.role === "toolResult");
    strictEqual(second.toolCallId, "original_normalized");
    deepStrictEqual(assistant.content, [
      { type: "toolCall", id: "original", name: "echo", arguments: {} },
    ]);
  });
  it("补齐孤立工具结果并把系统消息排在结果后", (): void => {
    const messages: Message[] = [
      assistantMessage(),
      { role: "system", content: "新指令", timestamp: 0 },
      { role: "user", content: "继续", timestamp: 0 },
    ];
    const result = transformMessages(messages, testModel("openai-completions"));
    deepStrictEqual(
      result.map((message: Message): string => message.role),
      ["assistant", "toolResult", "system", "user"],
    );
    const synthetic = result[1];
    ok(synthetic?.role === "toolResult");
    strictEqual(synthetic.isError, true);
    strictEqual(synthetic.toolCallId, "original");
  });
  it("空会话保持为空，并忽略失败或中止的助手历史", (): void => {
    const model = testModel("openai-completions");
    deepStrictEqual(transformMessages([], model), []);
    for (const stopReason of ["error", "aborted"] as const) {
      const message = { ...assistantMessage(), stopReason };
      deepStrictEqual(transformMessages([message], model), []);
    }
  });
  it("非视觉模型合并连续图片占位且不修改原消息", (): void => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image", data: "a", mimeType: "image/jpeg" },
          { type: "image", data: "b", mimeType: "image/jpeg" },
        ],
        timestamp: 0,
      },
    ];
    const result = transformMessages(messages, {
      ...testModel("openai-completions"),
      input: ["text"],
    });
    const user = result[0];
    ok(user?.role === "user");
    deepStrictEqual(user.content, [
      { type: "text", text: "(image omitted: model does not support images)" },
    ]);
    const original = messages[0];
    ok(original?.role === "user");
    strictEqual(original.content.length, 2);
  });
  it("跨模型思考转为文本并去掉加密思考", (): void => {
    const message = assistantMessage();
    message.stopReason = "stop";
    message.content = [
      { type: "thinking", thinking: "推理" },
      { type: "thinking", thinking: "", thinkingSignature: "encrypted", redacted: true },
    ];
    const result = transformMessages([message], testModel("openai-completions"));
    const assistant = result[0];
    ok(assistant?.role === "assistant");
    deepStrictEqual(assistant.content, [{ type: "text", text: "推理" }]);
  });
  it("空内容外部历史归一为空数组", (): void => {
    const messages = [{ role: "user", content: null, timestamp: 0 }] as unknown as Message[];
    const result = transformMessages(messages, testModel("openai-completions"));
    deepStrictEqual(result, [{ role: "user", content: [], timestamp: 0 }]);
  });
  it("工具 ID 转换失败向调用方传播", (): void => {
    throws((): void => {
      transformMessages([assistantMessage()], testModel("openai-completions"), (): string => {
        throw new Error("转换失败");
      });
    }, /转换失败/);
    throws((): void => {
      transformMessages([assistantMessage()], null as unknown as Model);
    }, TypeError);
  });
});

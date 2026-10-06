import { deepStrictEqual, match, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { complete, completeSimple, stream, streamSimple } from "../../src/ai/stream.ts";
import type { Api, AssistantMessageEvent, Model } from "../../src/ai/types.ts";
import { collectStream, eventResponse, protocolEvents, testModel } from "./fixtures.ts";

for (const [name, createStream] of [
  ["stream", stream],
  ["streamSimple", streamSimple],
] as const) {
  describe(name, (): void => {
    it("规范化上下文后分发三个协议并返回文本结果", async (): Promise<void> => {
      for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
        const responseStream = createStream(
          testModel(api),
          { systemPrompt: "中文回答", messages: [{ role: "user", content: "你好", timestamp: 0 }] },
          {
            apiKey: "test-key",
            fetch: async (): Promise<Response> => eventResponse(protocolEvents(api)),
          },
        );
        const result = await collectStream(responseStream);
        strictEqual(result.message.api, api);
        strictEqual(result.message.stopReason, "stop");
        const text = result.message.content[0];
        strictEqual(text?.type, "text");
        if (text?.type === "text") {
          strictEqual(text.text, "你好");
        }
      }
    });
    it("空会话可以完成请求，已取消请求生成单个 aborted 事件", async (): Promise<void> => {
      const model = testModel("openai-completions");
      const normal = await collectStream(
        createStream(
          model,
          { messages: [] },
          {
            apiKey: "test-key",
            fetch: async (): Promise<Response> => eventResponse(protocolEvents(model.api)),
          },
        ),
      );
      strictEqual(normal.message.stopReason, "stop");
      const abortedStream = createStream(
        model,
        { messages: [] },
        { apiKey: "test-key", signal: AbortSignal.abort() },
      );
      const aborted = await collectStream(abortedStream);
      strictEqual(aborted.message.stopReason, "aborted");
      strictEqual(aborted.events.length, 1);
    });
    it("无效协议、模型字段与密钥返回错误流并且不发请求", async (): Promise<void> => {
      const model = testModel("openai-completions");
      const invalidModels: Model[] = [
        { ...model, api: "invalid" as Api },
        { ...model, id: " " },
        { ...model, baseUrl: " " },
      ];
      for (const invalidModel of invalidModels) {
        const responseStream = createStream(invalidModel, { messages: [] }, { apiKey: "test-key" });
        const result = await collectStream(responseStream);
        strictEqual(result.message.stopReason, "error");
        deepStrictEqual(
          result.events.map((event: AssistantMessageEvent): string => event.type),
          ["error"],
        );
      }
      const responseStream = createStream(model, { messages: [] }, { apiKey: "" });
      const result = await collectStream(responseStream);
      strictEqual(result.message.stopReason, "error");
      match(result.message.errorMessage ?? "", /apiKey/);
    });
  });
}

for (const [name, createComplete] of [
  ["complete", complete],
  ["completeSimple", completeSimple],
] as const) {
  describe(name, (): void => {
    it("等待协议流完成并返回助手消息", async (): Promise<void> => {
      const model = testModel("openai-completions");
      const message = await createComplete(
        model,
        { messages: [{ role: "user", content: "你好", timestamp: 0 }] },
        {
          apiKey: "test-key",
          fetch: async (): Promise<Response> => eventResponse(protocolEvents(model.api)),
        },
      );
      strictEqual(message.stopReason, "stop");
      deepStrictEqual(message.content, [{ type: "text", text: "你好" }]);
    });
    it("空会话可完成且中断信号兑现为 aborted 消息", async (): Promise<void> => {
      const model = testModel("openai-completions");
      const message = await createComplete(
        model,
        { messages: [] },
        {
          apiKey: "test-key",
          fetch: async (): Promise<Response> => eventResponse(protocolEvents(model.api)),
        },
      );
      strictEqual(message.stopReason, "stop");
      const aborted = await createComplete(
        model,
        { messages: [] },
        { apiKey: "test-key", signal: AbortSignal.abort() },
      );
      strictEqual(aborted.stopReason, "aborted");
    });
    it("校验和 HTTP 错误兑现为 error 消息", async (): Promise<void> => {
      const model = testModel("openai-completions");
      const invalid = await createComplete(model, { messages: [] }, { apiKey: " " });
      strictEqual(invalid.stopReason, "error");
      match(invalid.errorMessage ?? "", /apiKey/);
      const failed = await createComplete(
        model,
        { messages: [] },
        {
          apiKey: "test-key",
          maxRetries: 0,
          fetch: async (): Promise<Response> =>
            new Response('{"error":{"message":"离线错误"}}', {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }),
        },
      );
      strictEqual(failed.stopReason, "error");
      match(failed.errorMessage ?? "", /离线错误/);
    });
  });
}

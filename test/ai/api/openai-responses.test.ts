import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { stream, streamSimple } from "../../../src/ai/api/openai-responses.ts";
import type { AssistantMessageEvent } from "../../../src/ai/types.ts";
import { normalizeContext } from "../../../src/ai/utils/transcript.ts";
import { collectStream, eventResponse, protocolEvents, testModel } from "../fixtures.ts";

for (const [name, createStream] of [
  ["stream", stream],
  ["streamSimple", streamSimple],
] as const) {
  describe(`openai-responses ${name}`, (): void => {
    it("离线文本分片按序输出并保留缓存及 token 用量", async (): Promise<void> => {
      const model = testModel("openai-responses");
      const context = normalizeContext({
        messages: [{ role: "user", content: "你好", timestamp: 0 }],
      });
      const responseStream = createStream(model, context, {
        apiKey: "test-key",
        fetch: async (): Promise<Response> => eventResponse(protocolEvents(model.api)),
      });
      const result = await collectStream(responseStream);
      strictEqual(result.message.stopReason, "stop");
      const text = result.message.content[0];
      ok(text?.type === "text");
      strictEqual(text.text, "你好");
      const textEvents = result.events.filter(
        (event: AssistantMessageEvent): boolean => event.type === "text_delta",
      );
      const deltas = textEvents.map((event: AssistantMessageEvent): string =>
        event.type === "text_delta" ? event.delta : "",
      );
      deepStrictEqual(deltas, ["你", "好"]);
      strictEqual(result.events[0]?.type, "start");
      strictEqual(result.events.at(-1)?.type, "done");
      strictEqual(result.message.usage.input, 8);
      strictEqual(result.message.usage.output, 3);
      strictEqual(result.message.usage.cacheRead, 2);
      strictEqual(result.message.usage.totalTokens, 13);
    });

    it("工具 JSON 跨分片解析且结束时删除临时字段", async (): Promise<void> => {
      const model = testModel("openai-responses");
      const context = normalizeContext({ messages: [] });
      const responseStream = createStream(model, context, {
        apiKey: "test-key",
        fetch: async (): Promise<Response> => eventResponse(protocolEvents(model.api, true)),
      });
      const result = await collectStream(responseStream);
      strictEqual(result.message.stopReason, "toolUse");
      const call = result.message.content[0];
      ok(call?.type === "toolCall");
      strictEqual(call.id, "call_test|fc_test");
      strictEqual(call.name, "echo");
      deepStrictEqual(call.arguments, { input: "你好" });
      strictEqual("partialJson" in call, false);
      strictEqual("partialArgs" in call, false);
      ok(
        result.events.some(
          (event: AssistantMessageEvent): boolean => event.type === "toolcall_start",
        ),
      );
      ok(
        result.events.some(
          (event: AssistantMessageEvent): boolean => event.type === "toolcall_delta",
        ),
      );
      ok(
        result.events.some(
          (event: AssistantMessageEvent): boolean => event.type === "toolcall_end",
        ),
      );
    });

    it("空白密钥在传输前产生单个错误事件", async (): Promise<void> => {
      let requests = 0;
      const responseStream = createStream(
        testModel("openai-responses"),
        normalizeContext({ messages: [] }),
        {
          apiKey: " ",
          fetch: async (): Promise<Response> => {
            requests++;
            throw new Error("不应访问传输");
          },
        },
      );
      const result = await collectStream(responseStream);
      strictEqual(requests, 0);
      strictEqual(result.events.length, 1);
      strictEqual(result.events[0]?.type, "error");
      strictEqual(result.message.stopReason, "error");
      match(result.message.errorMessage ?? "", /apiKey/);
    });

    it("已中断信号正常结束为 aborted", async (): Promise<void> => {
      const responseStream = createStream(
        testModel("openai-responses"),
        normalizeContext({ messages: [] }),
        {
          apiKey: "test-key",
          signal: AbortSignal.abort(),
          maxRetries: 0,
          fetch: async (): Promise<Response> => {
            throw new DOMException("已中断", "AbortError");
          },
        },
      );
      const result = await collectStream(responseStream);
      strictEqual(result.message.stopReason, "aborted");
      strictEqual(result.events.at(-1)?.type, "error");
    });

    it("流缺少终止事件时保留已生成文本并返回错误", async (): Promise<void> => {
      const events = protocolEvents("openai-responses");
      events.splice(4);
      const responseStream = createStream(
        testModel("openai-responses"),
        normalizeContext({ messages: [] }),
        {
          apiKey: "test-key",
          maxRetries: 0,
          fetch: async (): Promise<Response> => eventResponse(events),
        },
      );
      const result = await collectStream(responseStream);
      strictEqual(result.message.stopReason, "error");
      ok(result.message.content.length > 0);
      strictEqual(result.events.at(-1)?.type, "error");
    });

    it("HTTP 错误返回错误消息并停止重试", async (): Promise<void> => {
      let requests = 0;
      const responseStream = createStream(
        testModel("openai-responses"),
        normalizeContext({ messages: [] }),
        {
          apiKey: "test-key",
          maxRetries: 0,
          fetch: async (): Promise<Response> => {
            requests++;
            return new Response('{"error":{"message":"离线错误"}}', {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
      );
      const result = await collectStream(responseStream);
      strictEqual(requests, 1);
      strictEqual(result.message.stopReason, "error");
      match(result.message.errorMessage ?? "", /离线错误/);
    });
  });
}

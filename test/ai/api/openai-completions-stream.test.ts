import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type { AssistantMessageEvent } from "../../../src/ai/types.ts";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { processCompletionsStream } from "../../../src/ai/api/openai-completions-stream.ts";
import { AssistantMessageEventStream } from "../../../src/ai/utils/event-stream.ts";
import { collectStream, protocolEvents, testModel } from "../fixtures.ts";
import { assistant } from "../helpers.ts";

async function* chunks(events: Record<string, unknown>[]): AsyncGenerator<ChatCompletionChunk> {
  for (const event of events) {
    yield event as unknown as ChatCompletionChunk;
  }
}

describe("processCompletionsStream", (): void => {
  it("消费文本分片完成内容事件并返回 finish_reason 状态", async (): Promise<void> => {
    const output = assistant({ model: "test-model", content: [], stopReason: "pending" });
    const events = new AssistantMessageEventStream();
    const source = chunks(protocolEvents("openai-completions"));
    const result = await processCompletionsStream(
      source,
      output,
      testModel("openai-completions"),
      new Map(),
      events,
    );
    deepStrictEqual(result, { hasFinishReason: true });
    deepStrictEqual(output.content, [{ type: "text", text: "你好" }]);
    strictEqual(output.stopReason, "stop");
    strictEqual(output.responseId, "chat_test");
    strictEqual(output.usage.input, 8);
    strictEqual(output.usage.cacheRead, 2);
    strictEqual(output.usage.output, 3);
    events.end(output);
    const collected = await collectStream(events);
    deepStrictEqual(
      collected.events.map((event: AssistantMessageEvent): string => event.type),
      ["text_start", "text_delta", "text_delta", "text_end"],
    );
  });

  it("空响应返回未收到 finish_reason 且保留 pending 交给入口判定", async (): Promise<void> => {
    const output = assistant({ content: [], stopReason: "pending" });
    const events = new AssistantMessageEventStream();
    const result = await processCompletionsStream(
      chunks([]),
      output,
      testModel("openai-completions"),
      new Map(),
      events,
    );
    deepStrictEqual(result, { hasFinishReason: false });
    deepStrictEqual(output.content, []);
    strictEqual(output.stopReason, "pending");
    events.end(output);
    const collected = await collectStream(events);
    deepStrictEqual(collected.events, []);
  });

  it("解析回调失败时回填签名原样抛错并保留入口负责清理的工具字段", async (): Promise<void> => {
    const details = [{ type: "reasoning.encrypted", data: "密文" }];
    const source = chunks([
      {
        id: "chat_test",
        choices: [
          {
            delta: {
              reasoning_details: details,
              tool_calls: [
                { index: 0, id: "call_test", function: { name: "echo", arguments: '{"value":1}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { id: "chat_test", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const output = assistant({ content: [], stopReason: "pending" });
    const events = new AssistantMessageEventStream();
    const failure = new Error("原始解析异常");
    let count = 0;
    await rejects(
      processCompletionsStream(
        source,
        output,
        testModel("openai-completions"),
        new Map(),
        events,
        (): void => {
          count++;
          if (count === 2) {
            throw failure;
          }
        },
      ),
      (error: unknown): boolean => error === failure,
    );
    const thinking = output.content[1];
    ok(thinking?.type === "thinking");
    strictEqual(thinking.thinkingSignature, JSON.stringify(details));
    const call = output.content[0];
    ok(call?.type === "toolCall");
    ok("partialArgs" in call);
    strictEqual(call.partialArgs, '{"value":1}');
    ok("streamIndex" in call);
    strictEqual(call.streamIndex, 0);
    strictEqual(output.stopReason, "pending");
    events.end(output);
    const collected = await collectStream(events);
    deepStrictEqual(
      collected.events.map((event: AssistantMessageEvent): string => event.type),
      ["toolcall_start", "toolcall_delta", "thinking_start"],
    );
  });
});

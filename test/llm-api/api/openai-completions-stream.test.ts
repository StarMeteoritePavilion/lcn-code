import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type { AssistantMessageEvent } from "../../../src/llm-api/types.ts";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { processCompletionsStream } from "../../../src/llm-api/api/openai-completions-stream.ts";
import { AssistantMessageEventStream } from "../../../src/llm-api/utils/event-stream.ts";
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

describe("processCompletionsStream：增量及终态分支", (): void => {
  it("所有兼容停止原因映射并保留原值", async (): Promise<void> => {
    const cases = [
      { raw: "end", reason: "stop" },
      { raw: "length", reason: "length" },
      { raw: "function_call", reason: "toolUse" },
      { raw: "content_filter", reason: "error" },
      { raw: "network_error", reason: "error" },
      { raw: "unexpected", reason: "error" },
    ];
    for (const entry of cases) {
      const output = assistant({ content: [], stopReason: "pending" });
      const stream = new AssistantMessageEventStream();
      const result = await processCompletionsStream(
        chunks([{ choices: [{ finish_reason: entry.raw }] }]),
        output,
        testModel("openai-completions"),
        new Map(),
        stream,
      );
      strictEqual(result.hasFinishReason, true);
      strictEqual(output.rawStopReason, entry.raw);
      strictEqual(output.stopReason, entry.reason);
      strictEqual(
        output.errorMessage,
        entry.reason === "error" ? `Endpoint finish_reason: ${entry.raw}` : undefined,
      );
    }
  });
  it("通过 ID 关联无索引增量并补齐名称及索引，自定义输入切换后正确完成", async (): Promise<void> => {
    const output = assistant({ content: [], stopReason: "pending" });
    const stream = new AssistantMessageEventStream();
    const events = [
      { choices: [{ delta: { tool_calls: [{ id: "custom" }] } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ id: "custom", index: 4, custom: { name: "echo", input: "甲" } }],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 4, custom: { input: "乙" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 5 }] } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 5, id: "function", function: { name: "echo", arguments: '{"value":1}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ finish_reason: "tool_calls" }] },
    ];
    await processCompletionsStream(
      chunks(events),
      output,
      testModel("openai-completions"),
      new Map([["echo", "input"]]),
      stream,
    );
    deepStrictEqual(output.content, [
      { type: "toolCall", id: "custom", name: "echo", arguments: { input: "甲乙" } },
      { type: "toolCall", id: "function", name: "echo", arguments: { value: 1 } },
    ]);
    stream.end(output);
    const collected = await collectStream(stream);
    const deltas = collected.events
      .filter((event: AssistantMessageEvent): boolean => event.type === "toolcall_delta")
      .map((event: AssistantMessageEvent): string =>
        event.type === "toolcall_delta" ? event.delta : "",
      );
    deepStrictEqual(deltas, ["", '{"input":"甲', "乙", "", '{"value":1}', '"}']);
  });
  it("忽略无效分片和 reasoning detail，优先推理正文并读取 choice 用量", async (): Promise<void> => {
    const output = assistant({ content: [], stopReason: "pending" });
    const stream = new AssistantMessageEventStream();
    const events = [
      null,
      1,
      {},
      { choices: [] },
      {
        model: "fallback",
        choices: [
          {
            usage: { prompt_tokens: 3, completion_tokens: 2, prompt_cache_hit_tokens: 1 },
            delta: {
              reasoning_content: "甲",
              reasoning: "忽略",
              reasoning_details: [{ type: "invalid" }],
            },
          },
        ],
      },
      {
        choices: [
          {
            usage: { prompt_tokens: 2, cached_tokens: 3 },
            delta: { reasoning_text: "乙" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    await processCompletionsStream(
      chunks(events as Record<string, unknown>[]),
      output,
      testModel("openai-completions"),
      new Map(),
      stream,
    );
    deepStrictEqual(output.content, [
      { type: "thinking", thinking: "甲乙", thinkingSignature: "reasoning_content" },
    ]);
    strictEqual(output.responseModel, "fallback");
    strictEqual(output.usage.input, 0);
    strictEqual(output.usage.cacheRead, 3);
    strictEqual(output.usage.output, 0);
    strictEqual(output.usage.totalTokens, 3);
    stream.end(output);
    const collected = await collectStream(stream);
    deepStrictEqual(
      collected.events.map((event: AssistantMessageEvent): string => event.type),
      ["thinking_start", "thinking_delta", "thinking_delta", "thinking_end"],
    );
  });
});

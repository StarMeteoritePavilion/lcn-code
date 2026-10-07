import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { processAnthropicStream } from "../../../src/ai/api/anthropic-messages-stream.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../../../src/ai/types.ts";
import { AssistantMessageEventStream } from "../../../src/ai/utils/event-stream.ts";
import { eventResponse, protocolEvents, testModel } from "../fixtures.ts";

/**
 * 创建独立的解析结果消息。
 * @returns 初始待完成的 Anthropic 助手消息。
 */
function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    content: [],
    timestamp: 0,
    stopReason: "pending",
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

/**
 * 结束解析事件队列并收集内容事件，不等待入口终态消息。
 * @param stream - 解析函数写入的事件队列。
 * @returns 已写入的全部内容事件。
 */
async function readEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  stream.end();
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("processAnthropicStream", (): void => {
  it("累积文本和用量、返回输入变换但不追加诊断或公共终态", async (): Promise<void> => {
    const events = protocolEvents("anthropic-messages");
    const delta = events[5];
    ok(delta);
    const transformations = [
      { type: "thinking_dropped", path: "messages.0.content.0", reason: "prefix_binding_mismatch" },
    ];
    delta.input_transformations = transformations;
    const output = createOutput();
    const eventStream = new AssistantMessageEventStream();
    const result = await processAnthropicStream(
      eventResponse(events),
      testModel("anthropic-messages"),
      output,
      eventStream,
    );
    deepStrictEqual(result.inputTransformations, transformations);
    strictEqual(output.diagnostics, undefined);
    strictEqual(output.stopReason, "stop");
    strictEqual(output.usage.totalTokens, 13);
    deepStrictEqual(output.content, [{ type: "text", text: "你好" }]);
    const emitted = await readEvents(eventStream);
    deepStrictEqual(
      emitted.map((event: AssistantMessageEvent): string => event.type),
      ["text_start", "text_delta", "text_delta", "text_end"],
    );
  });

  it("空流保持 pending 并由入口负责后置检查", async (): Promise<void> => {
    const output = createOutput();
    const eventStream = new AssistantMessageEventStream();
    const result = await processAnthropicStream(
      eventResponse([]),
      testModel("anthropic-messages"),
      output,
      eventStream,
    );
    deepStrictEqual(result, { inputTransformations: undefined });
    strictEqual(output.stopReason, "pending");
    deepStrictEqual(await readEvents(eventStream), []);
  });

  it("缺少工具块 stop 时保留字段且不补发结束事件", async (): Promise<void> => {
    const events = protocolEvents("anthropic-messages", true).filter(
      (event: Record<string, unknown>): boolean => event.type !== "content_block_stop",
    );
    const output = createOutput();
    const eventStream = new AssistantMessageEventStream();
    await processAnthropicStream(
      eventResponse(events),
      testModel("anthropic-messages"),
      output,
      eventStream,
    );
    deepStrictEqual(output.content, [
      {
        type: "toolCall",
        id: "call_test",
        name: "echo",
        arguments: { input: "你好" },
        index: 0,
        partialJson: '{"input":"你好"}',
      },
    ]);
    const emitted = await readEvents(eventStream);
    strictEqual(
      emitted.some((event: AssistantMessageEvent): boolean => event.type === "toolcall_end"),
      false,
    );
  });

  it("解析回调原样拒绝并保留内容字段等待入口清理", async (): Promise<void> => {
    const failure = new Error("原生回调失败");
    const output = createOutput();
    const eventStream = new AssistantMessageEventStream();
    await rejects(
      processAnthropicStream(
        eventResponse(protocolEvents("anthropic-messages", true)),
        testModel("anthropic-messages"),
        output,
        eventStream,
        undefined,
        (value: unknown): void => {
          const event = value as Record<string, unknown>;
          if (event.type === "content_block_stop") {
            throw failure;
          }
        },
      ),
      (error: unknown): boolean => error === failure,
    );
    deepStrictEqual(output.content, [
      {
        type: "toolCall",
        id: "call_test",
        name: "echo",
        arguments: { input: "你好" },
        index: 0,
        partialJson: '{"input":"你好"}',
      },
    ]);
    const emitted = await readEvents(eventStream);
    strictEqual(emitted.at(-1)?.type, "toolcall_delta");
  });

  it("SSE 支持多行数据、不同换行、字节分片、ping 和无尾部空行", async (): Promise<void> => {
    const events = protocolEvents("anthropic-messages");
    const first = events.shift();
    ok(first);
    const text = await eventResponse(events).text();
    const firstData = JSON.stringify(first).replace(",", ",\r\ndata: ");
    const bodyText = `: 注释\r\nevent: ping\r\ndata: {}\r\n\r\nevent: message_start\r\ndata: ${firstData}\r\n\r\n${text.trimEnd()}`;
    const encoded = new TextEncoder().encode(bodyText);
    const body = new ReadableStream<Uint8Array>({
      /** 将离线 SSE 字节逐个入队，验证跨字节的 Unicode 解码。 */
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        for (let index = 0; index < encoded.length; index++) {
          const value = encoded[index];
          if (value === undefined) {
            throw new Error("离线字节流包含空位");
          }
          if (value === 13 && encoded[index + 1] === 10) {
            controller.enqueue(encoded.slice(index, index + 2));
            index++;
            continue;
          }
          controller.enqueue(Uint8Array.of(value));
        }
        controller.close();
      },
    });
    const output = createOutput();
    const eventStream = new AssistantMessageEventStream();
    await processAnthropicStream(
      new Response(body),
      testModel("anthropic-messages"),
      output,
      eventStream,
    );
    deepStrictEqual(output.content, [{ type: "text", text: "你好" }]);
    strictEqual(output.stopReason, "stop");
  });

  it("无 body、缺 message_stop、SSE error 和取消均拒绝", async (): Promise<void> => {
    const events = protocolEvents("anthropic-messages");
    events.pop();
    for (const [response, error] of [
      [new Response(null), /no body/],
      [eventResponse(events), /before message_stop/],
      [new Response("event: error\ndata: 服务端失败\n\n"), /服务端失败/],
    ] as const) {
      await rejects(
        processAnthropicStream(
          response,
          testModel("anthropic-messages"),
          createOutput(),
          new AssistantMessageEventStream(),
        ),
        error,
      );
    }
    await rejects(
      processAnthropicStream(
        eventResponse(protocolEvents("anthropic-messages")),
        testModel("anthropic-messages"),
        createOutput(),
        new AssistantMessageEventStream(),
        AbortSignal.abort(),
      ),
      /Request was aborted/,
    );
  });

  it("未知停止原因不会静默结束", async (): Promise<void> => {
    const events = protocolEvents("anthropic-messages");
    const delta = events[5];
    ok(delta);
    delta.delta = { stop_reason: "unsupported" };
    await rejects(
      processAnthropicStream(
        eventResponse(events),
        testModel("anthropic-messages"),
        createOutput(),
        new AssistantMessageEventStream(),
      ),
      /Unhandled stop reason: unsupported/,
    );
  });
});

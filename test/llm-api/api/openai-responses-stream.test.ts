import { deepStrictEqual, match, rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { processResponsesStream } from "../../../src/llm-api/api/openai-responses-stream.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../../../src/llm-api/types.ts";
import { AssistantMessageEventStream } from "../../../src/llm-api/utils/event-stream.ts";
import { collectStream, protocolEvents, testModel } from "../fixtures.ts";

/**
 * 把离线协议数据按顺序提供给原生事件消费者。
 * @param events - 已核对字段的协议事件。
 * @returns 独立的异步事件序列。
 */
async function* nativeEvents(
  events: Record<string, unknown>[],
): AsyncGenerator<ResponseStreamEvent> {
  for (const event of events) {
    yield event as unknown as ResponseStreamEvent;
  }
}

/**
 * 创建解析器所需的空助手消息。
 * @returns 初始状态为 pending 的独立助手消息。
 */
function emptyOutput(): AssistantMessage {
  const model = testModel("openai-responses");
  return {
    role: "assistant",
    api: model.api,
    baseUrl: model.baseUrl,
    model: model.id,
    content: [],
    stopReason: "pending",
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

describe("processResponsesStream", (): void => {
  it("解析正常文本、用量及服务等级计价并由入口负责最终事件", async (): Promise<void> => {
    const output = emptyOutput();
    const stream = new AssistantMessageEventStream();
    const model = testModel("openai-responses");
    model.cost = { input: 1000000, output: 2000000, cacheRead: 3000000, cacheWrite: 4000000 };
    await processResponsesStream(
      nativeEvents(protocolEvents("openai-responses")),
      output,
      stream,
      model,
      { serviceTier: "flex" },
    );
    stream.end(output);
    const result = await collectStream(stream);
    strictEqual(output.stopReason, "stop");
    deepStrictEqual(output.content, [
      { type: "text", text: "你好", textSignature: '{"v":1,"id":"msg_test"}' },
    ]);
    deepStrictEqual(output.usage.cost, {
      input: 4,
      output: 3,
      cacheRead: 3,
      cacheWrite: 0,
      total: 10,
    });
    deepStrictEqual(
      result.events.map((event: AssistantMessageEvent): string => event.type),
      ["text_start", "text_delta", "text_delta", "text_end"],
    );
  });

  it("无内容终态成功且无终态空流拒绝", async (): Promise<void> => {
    const output = emptyOutput();
    await processResponsesStream(
      nativeEvents([{ type: "response.completed", response: { status: "completed", output: [] } }]),
      output,
      new AssistantMessageEventStream(),
      testModel("openai-responses"),
    );
    strictEqual(output.stopReason, "stop");
    deepStrictEqual(output.content, []);
    await rejects(
      processResponsesStream(
        nativeEvents([]),
        emptyOutput(),
        new AssistantMessageEventStream(),
        testModel("openai-responses"),
      ),
      /before a terminal response event/,
    );
  });

  it("解析回调异常原样传播且解析器不清理失败缓冲或发公共终态", async (): Promise<void> => {
    const output = emptyOutput();
    const stream = new AssistantMessageEventStream();
    const error = new Error("解析回调错误");
    await rejects(
      processResponsesStream(
        nativeEvents(protocolEvents("openai-responses", true)),
        output,
        stream,
        testModel("openai-responses"),
        {
          /**
           * 在工具参数已累积后拒绝下一次原生事件处理。
           * @param event - 本次原生协议事件。
           */
          onStreamEvent: (event: unknown): void => {
            if ((event as { type: string }).type === "response.output_item.done") {
              throw error;
            }
          },
        },
      ),
      (actual: unknown): boolean => actual === error,
    );
    const call = output.content[0];
    strictEqual(call?.type, "toolCall");
    match((call as unknown as { partialJson: string }).partialJson, /你好/);
    stream.end(output);
    const result = await collectStream(stream);
    deepStrictEqual(
      result.events.map((event: AssistantMessageEvent): string => event.type),
      ["toolcall_start", "toolcall_delta", "toolcall_delta"],
    );
  });
});

describe("Responses 推理摘要增量", (): void => {
  it("摘要分段结束追加空行并保留最终签名", async (): Promise<void> => {
    const item = { type: "reasoning", id: "r1", summary: [], encrypted_content: "encrypted" };
    const output = emptyOutput();
    const stream = new AssistantMessageEventStream();
    await processResponsesStream(
      nativeEvents([
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "摘要" },
        { type: "response.reasoning_summary_part.done", output_index: 0 },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: { status: "completed", output: [item, { ...item, id: "unknown" }] },
        },
      ]),
      output,
      stream,
      testModel("openai-responses"),
    );
    strictEqual(output.content[0]?.type, "thinking");
    const block = output.content[0];
    if (block?.type === "thinking") {
      strictEqual(block.thinking, "摘要\n\n");
      strictEqual(block.thinkingSignature, JSON.stringify(item));
    }
  });
});

describe("Responses 非消息输出兼容", (): void => {
  it("托管工具输出忽略正文槽位且不影响完成状态", async (): Promise<void> => {
    const output = emptyOutput();
    const stream = new AssistantMessageEventStream();
    await processResponsesStream(
      nativeEvents([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "web_search_call", id: "ws_1", status: "completed" },
        },
        { type: "response.reasoning_summary_part.done", output_index: 1 },
        { type: "response.reasoning_text.delta", output_index: 1, delta: "未知推理槽位" },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "web_search_call", id: "ws_1", status: "completed" },
        },
        { type: "response.completed", response: { status: "completed", output: [] } },
      ]),
      output,
      stream,
      testModel("openai-responses"),
    );
    strictEqual(output.stopReason, "stop");
    deepStrictEqual(output.content, []);
  });
});

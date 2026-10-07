import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import {
  stream,
  streamSimple,
  type AnthropicOptions,
} from "../../../src/ai/api/anthropic-messages.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool } from "../../../src/ai/types.ts";
import { normalizeContext } from "../../../src/ai/utils/transcript.ts";
import { collectStream, eventResponse, protocolEvents, testModel } from "../fixtures.ts";

for (const [name, createStream] of [
  ["stream", stream],
  ["streamSimple", streamSimple],
] as const) {
  describe(`anthropic-messages ${name}`, (): void => {
    it("离线文本分片按序输出并保留缓存及 token 用量", async (): Promise<void> => {
      const model = testModel("anthropic-messages");
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
      const model = testModel("anthropic-messages");
      const context = normalizeContext({ messages: [] });
      const responseStream = createStream(model, context, {
        apiKey: "test-key",
        fetch: async (): Promise<Response> => eventResponse(protocolEvents(model.api, true)),
      });
      const result = await collectStream(responseStream);
      strictEqual(result.message.stopReason, "toolUse");
      const call = result.message.content[0];
      ok(call?.type === "toolCall");
      strictEqual(call.id, "call_test");
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
        testModel("anthropic-messages"),
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
        testModel("anthropic-messages"),
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
      const events = protocolEvents("anthropic-messages");
      events.splice(5);
      const responseStream = createStream(
        testModel("anthropic-messages"),
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
        testModel("anthropic-messages"),
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

/**
 * 提取不依赖可变 partial 引用的事件序列。
 * @param events - 收集的助手事件。
 * @returns 事件类型、内容索引与增量快照。
 */
function eventSequence(events: AssistantMessageEvent[]): unknown[] {
  return events.map((event: AssistantMessageEvent): unknown => ({
    type: event.type,
    ...("contentIndex" in event ? { contentIndex: event.contentIndex } : {}),
    ...("delta" in event ? { delta: event.delta } : {}),
  }));
}

/**
 * 创建带服务端输入变换记录的完整工具事件。
 * @returns 独立事件数组。
 */
function transformationEvents(): Record<string, unknown>[] {
  const events = protocolEvents("anthropic-messages", true);
  const first = events[0];
  ok(first);
  const message = first.message as Record<string, unknown>;
  message.input_transformations = [
    {
      type: "thinking_dropped",
      path: "/messages/0/content/0",
      reason: "prefix_binding_mismatch",
    },
  ];
  return events;
}

for (const [name, createStream] of [
  ["stream", stream],
  ["streamSimple", streamSimple],
] as const) {
  describe(`anthropic-messages ${name} 拆分前特征`, (): void => {
    it("思考签名分片与遮蔽载荷按块保存并能原样重放", async (): Promise<void> => {
      const model = testModel("anthropic-messages");
      const events = protocolEvents(model.api);
      events.splice(
        1,
        4,
        {
          type: "content_block_start",
          index: 4,
          content_block: { type: "thinking", thinking: "初始", signature: "sig-" },
        },
        {
          type: "content_block_delta",
          index: 4,
          delta: { type: "thinking_delta", thinking: "思考" },
        },
        {
          type: "content_block_delta",
          index: 4,
          delta: { type: "signature_delta", signature: "a" },
        },
        {
          type: "content_block_delta",
          index: 4,
          delta: { type: "signature_delta", signature: "b" },
        },
        { type: "content_block_stop", index: 4 },
        {
          type: "content_block_start",
          index: 8,
          content_block: { type: "redacted_thinking", data: "opaque" },
        },
        { type: "content_block_stop", index: 8 },
      );
      const result = await collectStream(
        createStream(model, normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          fetch: async (): Promise<Response> => eventResponse(events),
        }),
      );
      deepStrictEqual(result.message.content, [
        { type: "thinking", thinking: "初始思考", thinkingSignature: "sig-ab" },
        {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: "opaque",
          redacted: true,
        },
      ]);
      deepStrictEqual(eventSequence(result.events), [
        { type: "start" },
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_delta", contentIndex: 0, delta: "思考" },
        { type: "thinking_end", contentIndex: 0 },
        { type: "thinking_start", contentIndex: 1 },
        { type: "thinking_end", contentIndex: 1 },
        { type: "done" },
      ]);
      let payload: MessageCreateParamsStreaming | undefined;
      await collectStream(
        createStream(model, normalizeContext({ messages: [result.message] }), {
          apiKey: "test-key",
          onPayload: (value: unknown): void => {
            payload = structuredClone(value) as MessageCreateParamsStreaming;
          },
          fetch: async (): Promise<Response> => eventResponse(protocolEvents(model.api)),
        }),
      );
      deepStrictEqual(payload?.messages[0]?.content, [
        { type: "thinking", thinking: "初始思考", signature: "sig-ab" },
        { type: "redacted_thinking", data: "opaque" },
      ]);
    });

    it("回退发生在输出前且部分用量更新使用回退模型单价", async (): Promise<void> => {
      const model = testModel("anthropic-messages");
      model.cost = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
      model.compat = {
        allowedFallbackModels: [
          { model: "fallback-model", cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 } },
        ],
      };
      const events = protocolEvents(model.api);
      const first = events[0];
      ok(first);
      first.message = {
        id: "fallback-response",
        model: "fallback-model",
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 3,
          cache_creation: { ephemeral_1h_input_tokens: 1 },
        },
      };
      events.splice(1, 0, {
        type: "content_block_start",
        index: 9,
        content_block: {
          type: "fallback",
          from: { model: model.id },
          to: { model: "fallback-model" },
          trigger: { type: "refusal" },
        },
      });
      events[6] = {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: null,
          output_tokens: 5,
          cache_read_input_tokens: null,
          cache_creation: { ephemeral_1h_input_tokens: 2 },
          output_tokens_details: { thinking_tokens: 2 },
        },
      };
      const result = await collectStream(
        createStream(model, normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          fetch: async (): Promise<Response> => eventResponse(events),
        }),
      );
      strictEqual(result.message.responseId, "fallback-response");
      strictEqual(result.message.responseModel, "fallback-model");
      strictEqual(result.message.model, model.id);
      deepStrictEqual(result.message.content, [{ type: "text", text: "你好" }]);
      const usage = result.message.usage;
      deepStrictEqual(
        [
          usage.input,
          usage.output,
          usage.cacheRead,
          usage.cacheWrite,
          usage.cacheWrite1h,
          usage.reasoning,
          usage.totalTokens,
        ],
        [10, 5, 4, 3, 2, 2, 22],
      );
      ok(Math.abs(usage.cost.input - 0.00002) < 1e-15);
      ok(Math.abs(usage.cost.output - 0.00002) < 1e-15);
      strictEqual(usage.cost.cacheRead, 0.000004);
      strictEqual(usage.cost.cacheWrite, 0.000011);
      ok(Math.abs(usage.cost.total - 0.000055) < 1e-15);
    });

    it("输出中途的模型回退失败并保留已生成文本", async (): Promise<void> => {
      const events = protocolEvents("anthropic-messages");
      events.splice(4, 0, {
        type: "content_block_start",
        index: 9,
        content_block: {
          type: "fallback",
          from: { model: "test-model" },
          to: { model: "fallback-model" },
          trigger: { type: "refusal" },
        },
      });
      const result = await collectStream(
        createStream(testModel("anthropic-messages"), normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          fetch: async (): Promise<Response> => eventResponse(events),
        }),
      );
      strictEqual(result.message.stopReason, "error");
      match(result.message.errorMessage ?? "", /unsupported mid-output model fallback/);
      deepStrictEqual(result.message.content, [{ type: "text", text: "你好" }]);
      strictEqual(
        result.events.some((event: AssistantMessageEvent): boolean => event.type === "text_end"),
        false,
      );
    });

    it("输入变换诊断只在成功终态检查后追加", async (): Promise<void> => {
      const result = await collectStream(
        createStream(testModel("anthropic-messages"), normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          fetch: async (): Promise<Response> => eventResponse(transformationEvents()),
        }),
      );
      strictEqual(result.message.diagnostics?.[0]?.type, "anthropic_input_transformations");
      deepStrictEqual(result.message.diagnostics?.[0]?.details, {
        transformations: [
          {
            type: "thinking_dropped",
            path: "/messages/0/content/0",
            reason: "prefix_binding_mismatch",
          },
        ],
      });
      for (const shouldThrowInParser of [true, false]) {
        const events = transformationEvents().filter(
          (event: Record<string, unknown>): boolean => event.type !== "content_block_stop",
        );
        if (!shouldThrowInParser) {
          const delta = events.find(
            (event: Record<string, unknown>): boolean => event.type === "message_delta",
          );
          ok(delta);
          delta.delta = {};
        }
        const failure = await collectStream(
          createStream(testModel("anthropic-messages"), normalizeContext({ messages: [] }), {
            apiKey: "test-key",
            fetch: async (): Promise<Response> => eventResponse(events),
            onStreamEvent: (value: unknown): void => {
              const event = value as Record<string, unknown>;
              if (shouldThrowInParser && event.type === "message_delta") {
                throw new Error("解析回调失败");
              }
            },
          }),
        );
        strictEqual(failure.message.stopReason, "error");
        strictEqual(failure.message.diagnostics, undefined);
        const block = failure.message.content[0];
        ok(block?.type === "toolCall");
        deepStrictEqual(block.arguments, { input: "你好" });
        strictEqual("index" in block, false);
        strictEqual("partialJson" in block, false);
        strictEqual(failure.events.at(-1)?.type, "error");
        strictEqual(
          failure.events.some(
            (event: AssistantMessageEvent): boolean => event.type === "toolcall_end",
          ),
          false,
        );
        match(
          failure.message.errorMessage ?? "",
          shouldThrowInParser ? /解析回调失败/ : /without a stop reason/,
        );
      }
    });

    it("缺少块结束事件但消息正常结束时保留原临时字段", async (): Promise<void> => {
      const events = protocolEvents("anthropic-messages", true).filter(
        (event: Record<string, unknown>): boolean => event.type !== "content_block_stop",
      );
      const result = await collectStream(
        createStream(testModel("anthropic-messages"), normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          fetch: async (): Promise<Response> => eventResponse(events),
        }),
      );
      strictEqual(result.message.stopReason, "toolUse");
      deepStrictEqual(result.message.content, [
        {
          type: "toolCall",
          id: "call_test",
          name: "echo",
          arguments: { input: "你好" },
          index: 0,
          partialJson: '{"input":"你好"}',
        },
      ]);
      deepStrictEqual(eventSequence(result.events), [
        { type: "start" },
        { type: "toolcall_start", contentIndex: 0 },
        { type: "toolcall_delta", contentIndex: 0, delta: '{"input":' },
        { type: "toolcall_delta", contentIndex: 0, delta: '"你好"}' },
        { type: "done" },
      ]);
    });

    it("回调顺序与原生回调优先级保持不变且回调异常不重试", async (): Promise<void> => {
      const order: string[] = [];
      let requests = 0;
      const result = await collectStream(
        createStream(testModel("anthropic-messages"), normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          maxRetries: 2,
          onPayload: (payload: unknown): unknown => {
            order.push("payload");
            return payload;
          },
          fetch: async (): Promise<Response> => {
            requests++;
            order.push("fetch");
            return eventResponse(protocolEvents("anthropic-messages"));
          },
          onResponse: (): void => {
            order.push("response");
          },
          onStreamEvent: (value: unknown): void => {
            const event = value as Record<string, unknown>;
            order.push(String(event.type));
            if (event.type === "content_block_stop") {
              throw new Error("消费失败");
            }
          },
          onProviderStreamEvent: (): void => {
            order.push("legacy");
          },
        }),
      );
      deepStrictEqual(order, [
        "payload",
        "fetch",
        "response",
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
      ]);
      strictEqual(requests, 1);
      strictEqual(result.message.stopReason, "error");
      deepStrictEqual(result.message.content, [{ type: "text", text: "你好" }]);
      strictEqual(result.message.usage.input, 8);
    });

    it("并发流的工具参数与用量独立", async (): Promise<void> => {
      const results = await Promise.all(
        ["甲", "乙"].map(async (input: string, index: number): Promise<AssistantMessage> => {
          const events = protocolEvents("anthropic-messages", true);
          const delta = events[3];
          ok(delta);
          delta.delta = { type: "input_json_delta", partial_json: `${JSON.stringify(input)}}` };
          const usage = events[5];
          ok(usage);
          usage.usage = { output_tokens: index + 1 };
          const result = await collectStream(
            createStream(testModel("anthropic-messages"), normalizeContext({ messages: [] }), {
              apiKey: "test-key",
              fetch: async (): Promise<Response> => eventResponse(events),
            }),
          );
          return result.message;
        }),
      );
      deepStrictEqual(
        results.map((message: AssistantMessage): unknown => message.content),
        [
          [{ type: "toolCall", id: "call_test", name: "echo", arguments: { input: "甲" } }],
          [{ type: "toolCall", id: "call_test", name: "echo", arguments: { input: "乙" } }],
        ],
      );
      deepStrictEqual(
        results.map((message: AssistantMessage): number => message.usage.output),
        [1, 2],
      );
    });
  });
}

describe("anthropic-messages 请求特征", (): void => {
  it("动态工具与托管 effort 保留缓存前缀、beta 和服务端回退字段", async (): Promise<void> => {
    const model = testModel("anthropic-messages");
    model.compat = {
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
      supportsMidConvoEffort: true,
      supportsStrictTools: true,
      allowedFallbackModels: [{ model: "fallback-model" }],
    };
    const initial: Tool = {
      name: "old",
      description: "旧工具",
      parameters: Type.Object({ input: Type.String() }),
      constrainedSampling: { type: "json_schema", strict: "require" },
    };
    const added: Tool = {
      name: "new",
      description: "新工具",
      parameters: Type.Object({ input: Type.String() }),
    };
    const context = normalizeContext({
      messages: [
        { role: "system", content: "初始指令", toolsAdded: [initial], timestamp: 0 },
        { role: "user", content: "问题", timestamp: 0 },
        {
          role: "system",
          content: "更新指令",
          toolsAdded: [added],
          toolsRemoved: [initial],
          timestamp: 1,
        },
      ],
    });
    let payload: MessageCreateParamsStreaming | undefined;
    const result = await collectStream(
      stream(model, context, {
        apiKey: "test-key",
        cacheRetention: "long",
        effort: "low",
        temperature: 0.4,
        metadata: { user_id: "用户", ignored: "省略" },
        toolChoice: "any",
        onPayload: (value: unknown): void => {
          payload = structuredClone(value) as MessageCreateParamsStreaming;
        },
        fetch: async (): Promise<Response> => eventResponse(protocolEvents(model.api)),
      }),
    );
    ok(payload);
    strictEqual(result.message.thinkingEffort, "low");
    deepStrictEqual(payload.system, [
      { type: "text", text: "初始指令", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    strictEqual(payload.max_tokens, 8192);
    strictEqual(payload.temperature, undefined);
    deepStrictEqual(payload.metadata, { user_id: "用户" });
    deepStrictEqual(payload.tool_choice, { type: "any" });
    deepStrictEqual(payload.fallbacks, [{ model: "fallback-model" }]);
    deepStrictEqual(payload.betas, [
      "server-side-fallback-2026-07-01",
      "mid-conversation-output-config-2026-07-01",
      "thinking-binding-controls-2026-08-01",
      "inline-tools-2026-09-15",
    ]);
    deepStrictEqual(payload.thinking, {
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    deepStrictEqual(payload.output_config, { effort: "high" });
    deepStrictEqual(payload.tools, [
      {
        name: "old",
        description: "旧工具",
        eager_input_streaming: true,
        strict: true,
        input_schema: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        name: "__pi_deferred_placeholder__",
        description: "Reserved placeholder. Never available. Never call this.",
        input_schema: { type: "object", properties: {}, required: [] },
        defer_loading: true,
      },
    ]);
    deepStrictEqual(payload.messages, [
      { role: "user", content: "问题" },
      {
        role: "system",
        content: [
          { type: "text", text: "更新指令" },
          { type: "tool_removal", tool: { type: "tool_reference", name: "old" } },
          {
            type: "tool_addition",
            tool: {
              type: "tool_definition",
              definition: {
                name: "new",
                description: "新工具",
                eager_input_streaming: true,
                input_schema: {
                  type: "object",
                  properties: { input: { type: "string" } },
                  required: ["input"],
                },
              },
            },
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
      { role: "system", content: [], output_config: { effort: "low" } },
    ]);
  });
});

describe("anthropic-messages 传输与重放特征", (): void => {
  it("跨模型历史降级思考、规范工具 ID 并转换图片结果", async (): Promise<void> => {
    const model = testModel("anthropic-messages");
    const previous = await collectStream(
      stream(model, normalizeContext({ messages: [] }), {
        apiKey: "test-key",
        fetch: async (): Promise<Response> => eventResponse(protocolEvents(model.api)),
      }),
    );
    const history: AssistantMessage = {
      ...previous.message,
      model: "other-model",
      content: [
        { type: "thinking", thinking: "历史推理", thinkingSignature: "signature" },
        { type: "thinking", thinking: "隐藏", thinkingSignature: "opaque", redacted: true },
        { type: "toolCall", id: "id:1", name: "echo", arguments: {} },
        { type: "toolCall", id: "id:2", name: "echo", arguments: {} },
      ],
    };
    let payload: MessageCreateParamsStreaming | undefined;
    await collectStream(
      stream(
        model,
        normalizeContext({
          messages: [
            history,
            {
              role: "toolResult",
              toolCallId: "id:1",
              toolName: "echo",
              content: [{ type: "image", data: "YQ==", mimeType: "image/png" }],
              isError: false,
              timestamp: 1,
            },
            {
              role: "user",
              content: [
                { type: "text", text: "继续" },
                { type: "image", data: "Yg==", mimeType: "image/jpeg" },
              ],
              timestamp: 2,
            },
          ],
        }),
        {
          apiKey: "test-key",
          cacheRetention: "none",
          onPayload: (value: unknown): void => {
            payload = structuredClone(value) as MessageCreateParamsStreaming;
          },
          fetch: async (): Promise<Response> => eventResponse(protocolEvents(model.api)),
        },
      ),
    );
    deepStrictEqual(payload?.messages, [
      {
        role: "assistant",
        content: [
          { type: "text", text: "历史推理" },
          { type: "tool_use", id: "id_1", name: "echo", input: {} },
          { type: "tool_use", id: "id_2", name: "echo", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "id_1",
            content: [
              { type: "text", text: "(see attached image)" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
            ],
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "id_2",
            content: "No result provided",
            is_error: true,
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "继续" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Yg==" } },
        ],
      },
    ]);
  });

  it("请求替换保留 stream 且请求头 beta 覆盖、亲和及显式认证保持原规则", async (): Promise<void> => {
    const model = testModel("anthropic-messages");
    model.headers = { "anthropic-beta": "model-feature", authorization: "ignored" };
    model.compat = { sendSessionAffinityHeaders: true };
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    await collectStream(
      stream(model, normalizeContext({ messages: [] }), {
        apiKey: "explicit-key",
        sessionId: "session-1",
        headers: { "anthropic-beta": " custom-feature, custom-feature ", "api-key": "ignored" },
        onPayload: (value: unknown): unknown => {
          const payload = value as MessageCreateParamsStreaming;
          deepStrictEqual(payload.betas, ["custom-feature"]);
          return { ...payload, max_tokens: 123, stream: false };
        },
        fetch: async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requestHeaders = new Headers(init?.headers);
          return eventResponse(protocolEvents(model.api));
        },
      }),
    );
    strictEqual(requestBody?.stream, true);
    strictEqual(requestBody?.max_tokens, 123);
    strictEqual(requestHeaders?.get("x-api-key"), "explicit-key");
    strictEqual(requestHeaders?.has("authorization"), false);
    strictEqual(requestHeaders?.has("api-key"), false);
    strictEqual(requestHeaders?.get("x-session-affinity"), "session-1");
  });

  it("请求准备与响应回调失败均在 start 前结束", async (): Promise<void> => {
    for (const phase of ["payload", "response"]) {
      let requests = 0;
      const result = await collectStream(
        stream(testModel("anthropic-messages"), normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          onPayload: (): void => {
            if (phase === "payload") {
              throw new Error("准备失败");
            }
          },
          onResponse: (): void => {
            if (phase === "response") {
              throw new Error("响应失败");
            }
          },
          fetch: async (): Promise<Response> => {
            requests++;
            return eventResponse(protocolEvents("anthropic-messages"));
          },
        }),
      );
      strictEqual(requests, phase === "payload" ? 0 : 1);
      deepStrictEqual(eventSequence(result.events), [{ type: "error" }]);
      deepStrictEqual(result.message.content, []);
    }
  });

  it("流中中断保留部分工具参数、删除缓冲且不追加输入变换诊断", async (): Promise<void> => {
    const controller = new AbortController();
    const result = await collectStream(
      stream(testModel("anthropic-messages"), normalizeContext({ messages: [] }), {
        apiKey: "test-key",
        signal: controller.signal,
        fetch: async (): Promise<Response> => eventResponse(transformationEvents()),
        onStreamEvent: (value: unknown): void => {
          const event = value as Record<string, unknown>;
          if (event.type === "content_block_stop") {
            controller.abort();
          }
        },
      }),
    );
    strictEqual(result.message.stopReason, "aborted");
    deepStrictEqual(result.message.content, [
      { type: "toolCall", id: "call_test", name: "echo", arguments: { input: "你好" } },
    ]);
    strictEqual(result.message.diagnostics, undefined);
    strictEqual(result.events.at(-1)?.type, "error");
  });
});

describe("Anthropic 入口原生回调委托", (): void => {
  it("每个事件重新读取 options 回调并保持新旧回调优先级", async (): Promise<void> => {
    const order: string[] = [];
    const options: AnthropicOptions = {
      apiKey: "test-key",
      fetch: async (): Promise<Response> => eventResponse(protocolEvents("anthropic-messages")),
      onStreamEvent: firstEvent,
      onProviderStreamEvent: legacyEvent,
    };
    /** 记录首个事件并替换主回调。 */
    function firstEvent(value: unknown): void {
      const event = value as Record<string, unknown>;
      order.push(`first:${String(event.type)}`);
      options.onStreamEvent = nextEvent;
    }
    /** 记录第二个事件并移除主回调，让后续事件进入旧别名。 */
    function nextEvent(value: unknown): void {
      const event = value as Record<string, unknown>;
      order.push(`next:${String(event.type)}`);
      delete options.onStreamEvent;
    }
    /** 记录主回调被移除后的事件。 */
    function legacyEvent(value: unknown): void {
      const event = value as Record<string, unknown>;
      order.push(`legacy:${String(event.type)}`);
    }
    const result = await collectStream(
      stream(testModel("anthropic-messages"), normalizeContext({ messages: [] }), options),
    );
    strictEqual(result.message.stopReason, "stop");
    deepStrictEqual(order, [
      "first:message_start",
      "next:content_block_start",
      "legacy:content_block_delta",
      "legacy:content_block_delta",
      "legacy:content_block_stop",
      "legacy:message_delta",
      "legacy:message_stop",
    ]);
    match(result.message.content[0]?.type ?? "", /text/);
  });
});

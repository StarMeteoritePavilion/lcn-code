import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { Type } from "typebox";
import {
  stream,
  streamSimple,
  type OpenAICompletionsOptions,
} from "../../../src/ai/api/openai-completions.ts";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Tool,
} from "../../../src/ai/types.ts";
import { normalizeContext } from "../../../src/ai/utils/transcript.ts";
import { collectStream, eventResponse, protocolEvents, testModel } from "../fixtures.ts";
import { assistant, tool } from "../helpers.ts";

for (const [name, createStream] of [
  ["stream", stream],
  ["streamSimple", streamSimple],
] as const) {
  describe(`openai-completions ${name}`, (): void => {
    it("离线文本分片按序输出并保留缓存及 token 用量", async (): Promise<void> => {
      const model = testModel("openai-completions");
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
      const model = testModel("openai-completions");
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
        testModel("openai-completions"),
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
        testModel("openai-completions"),
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
      const events = protocolEvents("openai-completions");
      events.splice(2);
      const responseStream = createStream(
        testModel("openai-completions"),
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
        testModel("openai-completions"),
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
 * 以原入口已消费的字段创建一个离线补全分片。
 * @param delta - 原生消息增量。
 * @param finishReason - 原生停止原因，未结束时为 null。
 * @returns 独立分片。
 */
function completionChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: "chat_test",
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/**
 * 保留事件比较所需的稳定字段，避免引用后续仍在修改的 partial。
 * @param events - 已消费的助手事件。
 * @returns 事件类型、内容索引和增量快照。
 */
function eventSnapshot(events: AssistantMessageEvent[]): Record<string, unknown>[] {
  return events.map((event: AssistantMessageEvent): Record<string, unknown> => ({
    type: event.type,
    ...("contentIndex" in event ? { contentIndex: event.contentIndex } : {}),
    ...("delta" in event ? { delta: event.delta } : {}),
  }));
}

for (const [name, createStream] of [
  ["stream", stream],
  ["streamSimple", streamSimple],
] as const) {
  describe(`openai-completions ${name} 迁移特征`, (): void => {
    it("推理字段按非空值回退且多个字段同时出现时优先 reasoning_content", async (): Promise<void> => {
      const events = [
        completionChunk({
          content: "回答",
          reasoning_content: "优先",
          reasoning: "忽略",
          reasoning_text: "忽略",
        }),
        completionChunk({ reasoning_content: "", reasoning: "回退", reasoning_text: "忽略" }),
        completionChunk({ reasoning_content: null, reasoning: "", reasoning_text: "末项" }),
        completionChunk({}, "stop"),
      ];
      const result = await collectStream(
        createStream(testModel("openai-completions"), normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          fetch: async (): Promise<Response> => eventResponse(events),
        }),
      );
      deepStrictEqual(result.message.content, [
        { type: "text", text: "回答" },
        { type: "thinking", thinking: "优先回退末项", thinkingSignature: "reasoning_content" },
      ]);
      deepStrictEqual(eventSnapshot(result.events), [
        { type: "start" },
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "回答" },
        { type: "thinking_start", contentIndex: 1 },
        { type: "thinking_delta", contentIndex: 1, delta: "优先" },
        { type: "thinking_delta", contentIndex: 1, delta: "回退" },
        { type: "thinking_delta", contentIndex: 1, delta: "末项" },
        { type: "text_end", contentIndex: 0 },
        { type: "thinking_end", contentIndex: 1 },
        { type: "done" },
      ]);
    });

    for (const failure of ["正常", "解析内部", "入口终态"] as const) {
      it(`reasoning_details 合并及签名回填：${failure}`, async (): Promise<void> => {
        const details = [
          { type: "reasoning.text", text: "甲", id: null },
          {
            type: "reasoning.text",
            text: "乙",
            id: "r1",
            index: 2,
            format: "test",
            signature: "签名",
          },
          { type: "reasoning.summary", summary: "概" },
          { type: "reasoning.summary", summary: "述", id: "r2" },
          { type: "reasoning.encrypted", data: "密文一" },
          { type: "reasoning.encrypted", data: "密文二" },
          { type: "reasoning.text", text: 12 },
        ];
        const events = [
          completionChunk({
            reasoning_details: details,
            tool_calls: [
              {
                index: 0,
                id: "call_test",
                function: { name: "echo", arguments: '{"input":"部分"}' },
              },
            ],
          }),
          completionChunk({}, failure === "正常" ? "tool_calls" : null),
        ];
        let consumed = 0;
        const result = await collectStream(
          createStream(
            { ...testModel("openai-completions"), compat: { supportsFinishReason: true } },
            normalizeContext({ messages: [] }),
            {
              apiKey: "test-key",
              maxRetries: 0,
              fetch: async (): Promise<Response> => eventResponse(events),
              onStreamEvent: (): void => {
                consumed++;
                if (failure === "解析内部" && consumed === 2) {
                  throw new Error("解析回调失败");
                }
              },
            },
          ),
        );
        const thinking = result.message.content.find(
          (block: AssistantMessage["content"][number]): boolean => block.type === "thinking",
        );
        ok(thinking?.type === "thinking");
        deepStrictEqual(JSON.parse(thinking.thinkingSignature ?? ""), [
          {
            type: "reasoning.text",
            text: "甲乙",
            id: "r1",
            index: 2,
            format: "test",
            signature: "签名",
          },
          { type: "reasoning.summary", summary: "概述", id: "r2" },
          { type: "reasoning.encrypted", data: "密文一" },
          { type: "reasoning.encrypted", data: "密文二" },
        ]);
        strictEqual(thinking.thinking, "");
        const call = result.message.content.find(
          (block: AssistantMessage["content"][number]): boolean => block.type === "toolCall",
        );
        ok(call?.type === "toolCall");
        deepStrictEqual(call.arguments, { input: "部分" });
        for (const field of ["index", "partialArgs", "customInput", "streamIndex"]) {
          strictEqual(field in call, false);
        }
        const ends = result.events.filter((event: AssistantMessageEvent): boolean =>
          event.type.endsWith("_end"),
        );
        strictEqual(ends.length, failure === "解析内部" ? 0 : 2);
        strictEqual(result.events.at(-1)?.type, failure === "正常" ? "done" : "error");
        if (failure === "解析内部") {
          match(result.message.errorMessage ?? "", /解析回调失败/);
        }
        if (failure === "入口终态") {
          match(result.message.errorMessage ?? "", /finish_reason/);
        }
      });
    }

    it("工具增量通过 index 和 id 定位且交错调用保持首次创建顺序", async (): Promise<void> => {
      const events = [
        completionChunk({
          tool_calls: [
            { index: 2, id: "call_a", function: { name: "echo", arguments: '{"value":' } },
            { id: "call_b", function: { name: "echo", arguments: '{"value":' } },
          ],
        }),
        completionChunk({
          tool_calls: [
            { id: "call_b", function: { arguments: "2}" } },
            { index: 2, function: { arguments: "1}" } },
          ],
        }),
        completionChunk({}, "tool_calls"),
      ];
      const result = await collectStream(
        createStream(testModel("openai-completions"), normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          fetch: async (): Promise<Response> => eventResponse(events),
        }),
      );
      deepStrictEqual(result.message.content, [
        { type: "toolCall", id: "call_a", name: "echo", arguments: { value: 1 } },
        { type: "toolCall", id: "call_b", name: "echo", arguments: { value: 2 } },
      ]);
      const deltas = eventSnapshot(result.events).filter(
        (event: Record<string, unknown>): boolean => event.type === "toolcall_delta",
      );
      deepStrictEqual(deltas, [
        { type: "toolcall_delta", contentIndex: 0, delta: '{"value":' },
        { type: "toolcall_delta", contentIndex: 1, delta: '{"value":' },
        { type: "toolcall_delta", contentIndex: 1, delta: "2}" },
        { type: "toolcall_delta", contentIndex: 0, delta: "1}" },
      ]);
    });

    it("不支持 finish_reason 的端点根据工具存在性推断终态", async (): Promise<void> => {
      for (const hasTool of [false, true]) {
        const events = protocolEvents("openai-completions", hasTool).slice(0, 2);
        const result = await collectStream(
          createStream(
            { ...testModel("openai-completions"), compat: { supportsFinishReason: false } },
            normalizeContext({ messages: [] }),
            { apiKey: "test-key", fetch: async (): Promise<Response> => eventResponse(events) },
          ),
        );
        strictEqual(result.message.stopReason, hasTool ? "toolUse" : "stop");
        strictEqual(result.events.at(-1)?.type, "done");
      }
    });

    it("文法工具按声明属性累积原始输入并产生合法 JSON 增量", async (): Promise<void> => {
      const grammarTool: Tool = {
        name: "grammar",
        description: "文法工具",
        parameters: Type.Object({ source: Type.String() }),
        constrainedSampling: { type: "grammar", variants: { openai_regex: "[a-z]+" } },
      };
      let payload: Record<string, unknown> = {};
      const events = [
        completionChunk({
          tool_calls: [{ index: 0, id: "grammar_call", custom: { name: "grammar", input: "ab" } }],
        }),
        completionChunk({ tool_calls: [{ index: 0, custom: { input: "c" } }] }),
        completionChunk({}, "tool_calls"),
      ];
      const result = await collectStream(
        createStream(
          { ...testModel("openai-completions"), compat: { supportsOpenAIGrammarTools: true } },
          normalizeContext({ messages: [], tools: [grammarTool] }),
          {
            apiKey: "test-key",
            fetch: async (): Promise<Response> => eventResponse(events),
            onPayload: (value: unknown): void => {
              payload = structuredClone(value) as Record<string, unknown>;
            },
          },
        ),
      );
      deepStrictEqual(payload.tools, [
        {
          type: "custom",
          custom: {
            name: "grammar",
            description: "文法工具",
            format: { type: "grammar", grammar: { syntax: "regex", definition: "[a-z]+" } },
          },
        },
      ]);
      deepStrictEqual(result.message.content, [
        { type: "toolCall", id: "grammar_call", name: "grammar", arguments: { source: "abc" } },
      ]);
      const deltas = result.events.filter(
        (event: AssistantMessageEvent): boolean => event.type === "toolcall_delta",
      );
      const json = deltas
        .map((event: AssistantMessageEvent): string =>
          event.type === "toolcall_delta" ? event.delta : "",
        )
        .join("");
      deepStrictEqual(JSON.parse(json), { source: "abc" });
    });

    it("并发请求各自保留文本工具参数和用量", async (): Promise<void> => {
      const results = await Promise.all(
        [1, 2].map(async (value: number): Promise<Awaited<ReturnType<typeof collectStream>>> => {
          const events = [
            completionChunk({
              content: `文本${value}`,
              tool_calls: [
                {
                  index: 0,
                  id: `call_${value}`,
                  function: { name: "echo", arguments: `{"value":${value}}` },
                },
              ],
            }),
            {
              ...completionChunk({}, "tool_calls"),
              usage: { prompt_tokens: value * 10, completion_tokens: value },
            },
          ];
          return collectStream(
            createStream(testModel("openai-completions"), normalizeContext({ messages: [] }), {
              apiKey: "test-key",
              fetch: async (): Promise<Response> => eventResponse(events),
            }),
          );
        }),
      );
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        ok(result);
        const value = index + 1;
        deepStrictEqual(result.message.content, [
          { type: "text", text: `文本${value}` },
          { type: "toolCall", id: `call_${value}`, name: "echo", arguments: { value } },
        ]);
        strictEqual(result.message.usage.input, value * 10);
        strictEqual(result.message.usage.output, value);
        strictEqual(result.message.stopReason, "toolUse");
      }
    });

    it("回调顺序及 onStreamEvent 优先级固定且 onPayload 返回值覆盖请求", async (): Promise<void> => {
      const calls: string[] = [];
      let requestBody: Record<string, unknown> = {};
      const responseStream = createStream(
        testModel("openai-completions"),
        normalizeContext({ messages: [] }),
        {
          apiKey: "test-key",
          onPayload: (value: unknown): unknown => {
            calls.push("payload");
            return { ...(value as Record<string, unknown>), temperature: 0.25 };
          },
          fetch: async (
            _input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1],
          ): Promise<Response> => {
            calls.push("fetch");
            requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return eventResponse(protocolEvents("openai-completions"));
          },
          onResponse: (): void => {
            calls.push("response");
          },
          onStreamEvent: (): void => {
            calls.push("native");
          },
          onProviderStreamEvent: (): void => {
            throw new Error("旧回调不应调用");
          },
        },
      );
      for await (const event of responseStream) {
        calls.push(event.type);
      }
      strictEqual(requestBody.temperature, 0.25);
      deepStrictEqual(calls.slice(0, 4), ["payload", "fetch", "response", "start"]);
      strictEqual(calls.filter((value: string): boolean => value === "native").length, 3);
      strictEqual(calls.at(-1), "done");
    });
  });
}

describe("openai-completions 请求及重放迁移特征", (): void => {
  it("请求保留系统更新图片严格工具缓存及思考模板字段", async (): Promise<void> => {
    const strictTool: Tool = {
      ...tool("strict"),
      constrainedSampling: { type: "json_schema", strict: "require" },
    };
    const target: Model<"openai-completions"> = {
      ...testModel("openai-completions"),
      reasoning: true,
      thinkingLevelMap: { high: "mapped-high" },
      compat: {
        supportsMidConvoSystemMessages: true,
        supportsMidConvoToolAdditions: true,
        supportsStrictMode: true,
        cacheControlFormat: "anthropic",
        supportsLongCacheRetention: true,
        thinkingFormat: "chat-template",
        thinkingTokenBudgetField: "thinking_budget",
        chatTemplateKwargs: {
          enabled: { $var: "thinking.enabled" },
          effort: { $var: "thinking.effort" },
          budget: { $var: "thinking.budget" },
        },
      },
    };
    const context = normalizeContext({
      systemPrompt: "初始",
      tools: [strictTool],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "图片" },
            { type: "image", mimeType: "image/png", data: "AA==" },
          ],
          timestamp: 0,
        },
        { role: "system", content: "更新", toolsAdded: [tool("added")], timestamp: 1 },
      ],
    });
    let payload: Record<string, unknown> = {};
    const result = await collectStream(
      stream(target, context, {
        apiKey: "test-key",
        maxTokens: 4096,
        reasoningEffort: "high",
        thinkingBudgets: { high: 1000 },
        sessionId: "session",
        cacheRetention: "long",
        onPayload: (value: unknown): void => {
          payload = structuredClone(value) as Record<string, unknown>;
        },
        fetch: async (): Promise<Response> => eventResponse(protocolEvents("openai-completions")),
      }),
    );
    strictEqual(result.message.stopReason, "stop");
    strictEqual(payload.max_completion_tokens, 4096);
    strictEqual(payload.thinking_budget, 1000);
    deepStrictEqual(payload.chat_template_kwargs, {
      enabled: true,
      effort: "mapped-high",
      budget: 1000,
    });
    strictEqual(payload.prompt_cache_key, "session");
    strictEqual(payload.prompt_cache_retention, "24h");
    const messages = payload.messages as Record<string, unknown>[];
    deepStrictEqual(messages[0], {
      role: "developer",
      content: [{ type: "text", text: "初始", cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
    deepStrictEqual(messages[1], {
      role: "user",
      content: [
        { type: "text", text: "图片", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      ],
    });
    strictEqual(messages[2]?.role, "system");
    ok(Array.isArray(messages[2]?.tools));
    deepStrictEqual(messages[3], { role: "developer", content: "更新" });
    const tools = payload.tools as { function: Record<string, unknown>; cache_control: unknown }[];
    strictEqual(tools.length, 1);
    strictEqual(tools[0]?.function.strict, true);
    deepStrictEqual(tools[0]?.cache_control, { type: "ephemeral", ttl: "1h" });
  });

  it("同模型保留推理签名跨模型降级且工具 ID 与结果引用一致", async (): Promise<void> => {
    const target = testModel("openai-completions");
    const details = [{ type: "reasoning.encrypted", data: "密文" }];
    const same = assistant({
      model: target.id,
      content: [
        { type: "thinking", thinking: "同模型", thinkingSignature: JSON.stringify(details) },
        { type: "text", text: "同模型回答" },
      ],
    });
    const foreign = assistant({
      api: "openai-responses",
      model: "other",
      content: [
        { type: "thinking", thinking: "跨模型", thinkingSignature: "reasoning_content" },
        { type: "toolCall", id: "call|item", name: "echo", arguments: { value: 1 } },
      ],
    });
    const context = normalizeContext({
      messages: [same, foreign, { role: "user", content: "继续", timestamp: 2 }],
    });
    let payload: Record<string, unknown> = {};
    await collectStream(
      stream(target, context, {
        apiKey: "test-key",
        onPayload: (value: unknown): void => {
          payload = structuredClone(value) as Record<string, unknown>;
        },
        fetch: async (): Promise<Response> => eventResponse(protocolEvents("openai-completions")),
      }),
    );
    deepStrictEqual(payload.messages, [
      { role: "assistant", content: "同模型回答", reasoning_details: details },
      {
        role: "assistant",
        content: "跨模型",
        tool_calls: [
          {
            id: "call_item",
            type: "function",
            function: { name: "echo", arguments: '{"value":1}' },
          },
        ],
      },
      { role: "tool", content: "No result provided", tool_call_id: "call_item" },
      { role: "user", content: "继续" },
    ]);
    deepStrictEqual(payload.tools, []);
  });

  it("采样参数最后覆盖具名字段并保留会话请求头的覆盖顺序", async (): Promise<void> => {
    const target: Model<"openai-completions"> = {
      ...testModel("openai-completions"),
      samplingParams: { temperature: 0.1 },
      compat: {
        maxTokensField: "max_tokens",
        supportsUsageInStreaming: false,
        supportsStore: false,
        sendSessionAffinityHeaders: true,
        sessionAffinityFormat: "openrouter",
      },
    };
    let payload: Record<string, unknown> = {};
    let headers = new Headers();
    await collectStream(
      stream(target, normalizeContext({ messages: [] }), {
        apiKey: "test-key",
        maxTokens: 100,
        temperature: 0.5,
        samplingParams: { temperature: 0.9, max_tokens: 200 },
        sessionId: "original",
        headers: { "x-session-id": "override", authorization: "ignored", "x-api-key": "ignored" },
        onPayload: (value: unknown): void => {
          payload = structuredClone(value) as Record<string, unknown>;
        },
        fetch: async (
          _input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ): Promise<Response> => {
          headers = new Headers(init?.headers);
          return eventResponse(protocolEvents("openai-completions"));
        },
      }),
    );
    strictEqual(payload.temperature, 0.9);
    strictEqual(payload.max_tokens, 200);
    strictEqual("store" in payload, false);
    strictEqual("stream_options" in payload, false);
    strictEqual(headers.get("x-session-id"), "override");
    strictEqual(headers.get("authorization"), "Bearer test-key");
    strictEqual(headers.get("x-api-key"), null);
  });
});

describe("Completions 入口与解析模块协作", (): void => {
  it("每个分片重新读取回调并允许首个回调切换为新的处理函数", async (): Promise<void> => {
    const calls: string[] = [];
    const options: OpenAICompletionsOptions = {
      apiKey: "test-key",
      fetch: async (): Promise<Response> => eventResponse(protocolEvents("openai-completions")),
      onStreamEvent: (): void => {
        calls.push("首次");
        /** 记录替换后收到的原生分片。 */
        options.onStreamEvent = (): void => {
          calls.push("替换");
        };
      },
      onProviderStreamEvent: (): void => {
        throw new Error("旧回调不应调用");
      },
    };
    const response = stream(
      testModel("openai-completions"),
      normalizeContext({ messages: [] }),
      options,
    );
    const result = await collectStream(response);
    strictEqual(result.message.stopReason, "stop");
    deepStrictEqual(calls, ["首次", "替换", "替换"]);
  });
});

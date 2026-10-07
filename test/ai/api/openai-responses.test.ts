import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { stream, streamSimple } from "../../../src/ai/api/openai-responses.ts";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Tool,
} from "../../../src/ai/types.ts";
import { normalizeContext } from "../../../src/ai/utils/transcript.ts";
import { collectStream, eventResponse, protocolEvents, testModel } from "../fixtures.ts";

/**
 * 创建带有可选严格或文法约束的测试工具。
 * @param constrainedSampling - 工具的受限采样配置。
 * @returns 参数为 input 字符串的独立工具。
 */
function testTool(constrainedSampling?: Tool["constrainedSampling"]): Tool {
  return {
    name: "echo",
    description: "返回输入",
    parameters: Type.Object({ input: Type.String() }),
    ...(constrainedSampling === undefined ? {} : { constrainedSampling }),
  };
}

/**
 * 创建可校准文本条目的原生事件。
 * @param id - 消息标识。
 * @param text - 最终文本。
 * @returns SDK 使用的消息输出条目。
 */
function textItem(id: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

/**
 * 创建终态原生事件，保留可明确覆盖的响应字段。
 * @param response - 覆盖的响应字段。
 * @param type - 正常完成或未完成事件。
 * @returns 带默认用量的独立终态事件。
 */
function terminalEvent(
  response: Record<string, unknown> = {},
  type: "response.completed" | "response.incomplete" = "response.completed",
): Record<string, unknown> {
  return {
    type,
    response: {
      id: "resp_test",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        total_tokens: 13,
        input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
      ...response,
    },
  };
}

/**
 * 提取内容事件的稳定快照，避免 partial 后续变化污染预期。
 * @param events - 收到的助手事件。
 * @returns 事件类型、内容索引和内容增量组成的快照。
 */
function eventSnapshot(events: AssistantMessageEvent[]): unknown[] {
  return events.map((event: AssistantMessageEvent): unknown => ({
    type: event.type,
    ...("contentIndex" in event ? { contentIndex: event.contentIndex } : {}),
    ...("delta" in event ? { delta: event.delta } : {}),
    ...("content" in event ? { content: event.content } : {}),
  }));
}

/**
 * 创建同一端点模型的历史消息。
 * @param model - 消息使用的目标模型。
 * @param content - 历史内容块。
 * @returns 带有完整元数据的助手消息。
 */
function historyMessage(
  model: Model<"openai-responses">,
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    baseUrl: model.baseUrl,
    model: model.id,
    content,
    timestamp: 0,
    stopReason: "toolUse",
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

    it("交错 output_index 保持独立槽位并用最终条目校准内容及签名", async (): Promise<void> => {
      const reasoning = { type: "reasoning", id: "rs_test", summary: [] };
      const finalReasoning = {
        ...reasoning,
        summary: [{ type: "summary_text", text: "最终思考" }],
      };
      const tool = {
        type: "function_call",
        id: "fc_test",
        call_id: "call_test",
        name: "echo",
        arguments: "",
      };
      const events = [
        { type: "response.created", response: { id: "resp_initial" } },
        { type: "response.output_item.added", output_index: 4, item: textItem("msg_test", "") },
        { type: "response.output_item.added", output_index: 1, item: reasoning },
        { type: "response.output_item.added", output_index: 8, item: tool },
        { type: "response.reasoning_summary_text.delta", output_index: 1, delta: "临时思考" },
        { type: "response.output_text.delta", output_index: 4, delta: "临时文本" },
        { type: "response.function_call_arguments.delta", output_index: 8, delta: '{"input":' },
        { type: "response.output_text.delta", output_index: 8, delta: "不属于文本槽位" },
        {
          type: "response.function_call_arguments.done",
          output_index: 8,
          arguments: '{"input":"完成"}',
        },
        {
          type: "response.output_item.done",
          output_index: 4,
          item: textItem("msg_test", "最终文本"),
        },
        {
          type: "response.output_item.done",
          output_index: 8,
          item: { ...tool, arguments: '{"input":"校准"}', namespace: "tools" },
        },
        { type: "response.output_item.done", output_index: 1, item: finalReasoning },
        terminalEvent({ output: [{ ...finalReasoning, encrypted_content: "encrypted-test" }] }),
      ];
      const result = await collectStream(
        createStream(testModel("openai-responses"), normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          fetch: async (): Promise<Response> => eventResponse(events),
        }),
      );
      deepStrictEqual(result.message.content, [
        {
          type: "text",
          text: "最终文本",
          textSignature: '{"v":1,"id":"msg_test","phase":"final_answer"}',
        },
        {
          type: "thinking",
          thinking: "最终思考",
          thinkingSignature: JSON.stringify({
            ...finalReasoning,
            encrypted_content: "encrypted-test",
          }),
        },
        {
          type: "toolCall",
          id: "call_test|fc_test",
          name: "echo",
          arguments: { input: "校准" },
          namespace: "tools",
        },
      ]);
      deepStrictEqual(eventSnapshot(result.events), [
        { type: "start" },
        { type: "text_start", contentIndex: 0 },
        { type: "thinking_start", contentIndex: 1 },
        { type: "toolcall_start", contentIndex: 2 },
        { type: "thinking_delta", contentIndex: 1, delta: "临时思考" },
        { type: "text_delta", contentIndex: 0, delta: "临时文本" },
        { type: "toolcall_delta", contentIndex: 2, delta: '{"input":' },
        { type: "toolcall_delta", contentIndex: 2, delta: '"完成"}' },
        { type: "text_end", contentIndex: 0, content: "最终文本" },
        { type: "toolcall_end", contentIndex: 2 },
        { type: "thinking_end", contentIndex: 1, content: "最终思考" },
        { type: "done" },
      ]);
      strictEqual(result.message.responseId, "resp_test");
      strictEqual(result.message.usage.input, 7);
      strictEqual(result.message.usage.cacheWrite, 1);
      strictEqual(result.message.usage.reasoning, 1);
    });

    it("函数及文法调用在 length 终态保留缓冲而完成终态拒绝未结束调用", async (): Promise<void> => {
      for (const isCustom of [false, true]) {
        for (const isLength of [false, true]) {
          const model = testModel("openai-responses");
          model.compat = { supportsOpenAIGrammarTools: true };
          const item = isCustom
            ? {
                type: "custom_tool_call",
                id: "ctc_test",
                call_id: "call_test",
                name: "echo",
                input: "",
              }
            : {
                type: "function_call",
                id: "fc_test",
                call_id: "call_test",
                name: "echo",
                arguments: "",
              };
          const events = [
            { type: "response.output_item.added", output_index: 0, item },
            {
              type: isCustom
                ? "response.custom_tool_call_input.delta"
                : "response.function_call_arguments.delta",
              output_index: 0,
              delta: isCustom ? "hello" : '{"input":"hello"',
            },
            terminalEvent(
              isLength
                ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
                : {},
              isLength ? "response.incomplete" : "response.completed",
            ),
          ];
          const tool = testTool({ type: "grammar", variants: { openai_regex: "hello" } });
          const result = await collectStream(
            createStream(model, normalizeContext({ messages: [], tools: [tool] }), {
              apiKey: "test-key",
              fetch: async (): Promise<Response> => eventResponse(events),
            }),
          );
          const call = result.message.content[0];
          ok(call?.type === "toolCall");
          deepStrictEqual(call.arguments, { input: "hello" });
          strictEqual(result.message.stopReason, isLength ? "length" : "error");
          strictEqual(result.events.at(-1)?.type, isLength ? "done" : "error");
          strictEqual("partialJson" in call, isLength && !isCustom);
          strictEqual("customInput" in call, isLength && isCustom);
          if (isLength && !isCustom) {
            strictEqual(
              (call as typeof call & { partialJson: string }).partialJson,
              '{"input":"hello"',
            );
          }
          if (isLength && isCustom) {
            deepStrictEqual((call as typeof call & { customInput: unknown }).customInput, {
              property: "input",
              jsonBuffer: { input: "hello", started: true, closed: false },
            });
          }
          deepStrictEqual(
            result.events.map((event: AssistantMessageEvent): string => event.type),
            ["start", "toolcall_start", "toolcall_delta", isLength ? "done" : "error"],
          );
          if (!isLength) {
            match(result.message.errorMessage ?? "", /unfinished tool call/);
          }
        }
      }
    });

    it("文法输入完成事件修正文本并在条目结束时删除缓冲", async (): Promise<void> => {
      const model = testModel("openai-responses");
      model.compat = { supportsOpenAIGrammarTools: true };
      const item = {
        type: "custom_tool_call",
        id: "ctc_test",
        call_id: "call_test",
        name: "echo",
        input: "",
      };
      const result = await collectStream(
        createStream(
          model,
          normalizeContext({
            messages: [],
            tools: [testTool({ type: "grammar", variants: { openai_regex: "hello" } })],
          }),
          {
            apiKey: "test-key",
            fetch: async (): Promise<Response> =>
              eventResponse([
                { type: "response.output_item.added", output_index: 0, item },
                { type: "response.custom_tool_call_input.delta", output_index: 0, delta: "hel" },
                { type: "response.custom_tool_call_input.done", output_index: 0, input: "hello" },
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: { ...item, input: "hello", namespace: "tools" },
                },
                terminalEvent(),
              ]),
          },
        ),
      );
      deepStrictEqual(result.message.content, [
        {
          type: "toolCall",
          id: "call_test|ctc_test",
          name: "echo",
          arguments: { input: "hello" },
          namespace: "tools",
        },
      ]);
      strictEqual(result.message.stopReason, "toolUse");
      const deltas = result.events.filter(
        (event: AssistantMessageEvent): boolean => event.type === "toolcall_delta",
      );
      const json = deltas
        .map((event: AssistantMessageEvent): string =>
          event.type === "toolcall_delta" ? event.delta : "",
        )
        .join("");
      deepStrictEqual(JSON.parse(json), { input: "hello" });
    });

    it("解析内回调失败、取消及入口终态检查失败保留内容用量并清理缓冲", async (): Promise<void> => {
      for (const mode of ["callback", "abort", "content_filter", "failed"] as const) {
        const controller = new AbortController();
        const item = {
          type: "function_call",
          id: "fc_test",
          call_id: "call_test",
          name: "echo",
          arguments: "",
        };
        const prefix = [
          { type: "response.output_item.added", output_index: 0, item },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            delta: '{"input":"保留"}',
          },
        ];
        const end =
          mode === "failed"
            ? {
                type: "response.failed",
                response: {
                  status: "failed",
                  error: { code: "invalid_request", message: "提供商失败" },
                },
              }
            : terminalEvent(
                mode === "content_filter"
                  ? { status: "incomplete", incomplete_details: { reason: "content_filter" } }
                  : {},
                mode === "content_filter" ? "response.incomplete" : "response.completed",
              );
        const result = await collectStream(
          createStream(testModel("openai-responses"), normalizeContext({ messages: [] }), {
            apiKey: "test-key",
            signal: controller.signal,
            fetch: async (): Promise<Response> => eventResponse([...prefix, end]),
            onStreamEvent: (event: unknown): void => {
              const data = event as { type: string };
              if (data.type === "response.completed") {
                if (mode === "callback") {
                  throw new Error("解析回调失败");
                }
                if (mode === "abort") {
                  controller.abort();
                }
              }
            },
          }),
        );
        strictEqual(result.message.stopReason, mode === "abort" ? "aborted" : "error");
        const call = result.message.content[0];
        ok(call?.type === "toolCall");
        deepStrictEqual(call.arguments, { input: "保留" });
        strictEqual("partialJson" in call, false);
        strictEqual("customInput" in call, false);
        strictEqual("index" in call, false);
        deepStrictEqual(
          result.events.map((event: AssistantMessageEvent): string => event.type),
          ["start", "toolcall_start", "toolcall_delta", "error"],
        );
        if (mode === "content_filter") {
          strictEqual(result.message.rawStopReason, "incomplete.content_filter");
          strictEqual(result.message.usage.input, 7);
          match(result.message.errorMessage ?? "", /content_filter/);
        }
        if (mode === "callback") {
          match(result.message.errorMessage ?? "", /解析回调失败/);
        }
        if (mode === "failed") {
          strictEqual(result.message.rawStopReason, "failed");
          match(result.message.errorMessage ?? "", /提供商失败/);
        }
      }
    });

    it("请求回调按发送、响应、原生事件顺序执行且新事件回调优先", async (): Promise<void> => {
      const order: string[] = [];
      let payload: Record<string, unknown> | undefined;
      let transmitted: Record<string, unknown> | undefined;
      let requestHeaders: Headers | undefined;
      const model = testModel("openai-responses");
      model.headers = { "x-test": "model-value", "x-api-key": "must-not-send" };
      model.compat = {
        supportsStrictMode: true,
        supportsMidConvoSystemMessages: true,
        supportsAdditionalTools: true,
      };
      const tools = [testTool({ type: "json_schema", strict: "require" })];
      const context = normalizeContext({
        messages: [
          { role: "system", content: "初始指令", toolsAdded: tools, timestamp: 0 },
          {
            role: "user",
            content: [
              { type: "text", text: "文本" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
            timestamp: 0,
          },
          {
            role: "system",
            content: "更新指令",
            toolsAdded: [{ ...testTool(), name: "second" }],
            timestamp: 0,
          },
        ],
      });
      const result = await collectStream(
        createStream(model, context, {
          apiKey: "test-key",
          maxTokens: 1,
          temperature: 0.5,
          sessionId: "session-test",
          cacheRetention: "long",
          headers: { "x-test": "request-value", authorization: "must-not-send" },
          samplingParams: { temperature: 0.7 },
          onPayload: (value: unknown): unknown => {
            order.push("payload");
            payload = structuredClone(value) as Record<string, unknown>;
            return { ...(value as Record<string, unknown>), temperature: 0.9 };
          },
          fetch: async (
            _input: Parameters<typeof fetch>[0],
            init?: RequestInit,
          ): Promise<Response> => {
            order.push("fetch");
            transmitted = JSON.parse(init?.body as string) as Record<string, unknown>;
            requestHeaders = new Headers(init?.headers);
            return eventResponse(protocolEvents("openai-responses"));
          },
          onResponse: (): void => {
            order.push("response");
          },
          onStreamEvent: (value: unknown): void => {
            order.push((value as { type: string }).type);
          },
          onProviderStreamEvent: (): void => {
            throw new Error("旧回调不应执行");
          },
        }),
      );
      strictEqual(result.message.stopReason, "stop", result.message.errorMessage);
      deepStrictEqual(order, [
        "payload",
        "fetch",
        "response",
        ...protocolEvents("openai-responses").map(
          (event: Record<string, unknown>): unknown => event.type,
        ),
      ]);
      strictEqual(payload?.temperature, 0.7);
      strictEqual(transmitted?.temperature, 0.9);
      strictEqual(payload?.max_output_tokens, 16);
      strictEqual(payload?.prompt_cache_key, "session-test");
      strictEqual(payload?.prompt_cache_retention, "24h");
      strictEqual(payload?.store, false);
      strictEqual(payload?.stream, true);
      deepStrictEqual(payload?.tools, [
        {
          type: "function",
          name: "echo",
          description: "返回输入",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
          strict: true,
        },
      ]);
      deepStrictEqual(payload?.input, [
        { role: "system", content: "初始指令" },
        {
          role: "user",
          content: [
            { type: "input_text", text: "文本" },
            { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aGVsbG8=" },
          ],
        },
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "function",
              name: "second",
              description: "返回输入",
              parameters: {
                type: "object",
                properties: { input: { type: "string" } },
                required: ["input"],
              },
              strict: false,
            },
          ],
        },
        { role: "system", content: "更新指令" },
      ]);
      strictEqual(requestHeaders?.get("authorization"), "Bearer test-key");
      strictEqual(requestHeaders?.get("x-api-key"), null);
      strictEqual(requestHeaders?.get("x-test"), "request-value");
      strictEqual(requestHeaders?.get("session_id"), "session-test");
    });

    it("同模型历史保留签名和工具引用，跨模型降级并补缺失结果", async (): Promise<void> => {
      const model = testModel("openai-responses");
      const reasoning = {
        type: "reasoning",
        id: "rs_history",
        summary: [],
        encrypted_content: "history-encrypted",
      };
      const history = historyMessage(model, [
        { type: "thinking", thinking: "历史思考", thinkingSignature: JSON.stringify(reasoning) },
        {
          type: "text",
          text: "历史回答",
          textSignature: '{"v":1,"id":"msg_history","phase":"commentary"}',
        },
        {
          type: "toolCall",
          id: "call_history|fc_history",
          name: "echo",
          arguments: { input: "历史" },
          namespace: "tools",
        },
      ]);
      for (const isSameModel of [true, false]) {
        const target = { ...model, id: isSameModel ? model.id : "other-model" };
        let payload: Record<string, unknown> | undefined;
        const result = await collectStream(
          createStream(target, normalizeContext({ messages: [history] }), {
            apiKey: "test-key",
            fetch: async (): Promise<Response> => eventResponse(protocolEvents("openai-responses")),
            onPayload: (value: unknown): void => {
              payload = structuredClone(value) as Record<string, unknown>;
            },
          }),
        );
        strictEqual(result.message.stopReason, "stop");
        const input = payload?.input as Record<string, unknown>[];
        if (isSameModel) {
          deepStrictEqual(input, [
            reasoning,
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "历史回答", annotations: [] }],
              status: "completed",
              id: "msg_history",
              phase: "commentary",
            },
            {
              type: "function_call",
              id: "fc_history",
              call_id: "call_history",
              name: "echo",
              arguments: '{"input":"历史"}',
              namespace: "tools",
            },
            { type: "function_call_output", call_id: "call_history", output: "No result provided" },
          ]);
        } else {
          strictEqual(input[0]?.type, "message");
          deepStrictEqual(input[0]?.content, [
            { type: "output_text", text: "历史思考", annotations: [] },
          ]);
          strictEqual(input[1]?.id, "msg_pi_0_1");
          strictEqual(input[1]?.phase, undefined);
          strictEqual(input[2]?.id, undefined);
          strictEqual(input[2]?.namespace, undefined);
          strictEqual(input[2]?.call_id, "call_history");
          deepStrictEqual(input[3], {
            type: "function_call_output",
            call_id: "call_history",
            output: "No result provided",
          });
        }
      }
    });

    it("已完成内容在流内取消后由入口返回 aborted 并保留签名用量", async (): Promise<void> => {
      const controller = new AbortController();
      const result = await collectStream(
        createStream(testModel("openai-responses"), normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          signal: controller.signal,
          fetch: async (): Promise<Response> => eventResponse(protocolEvents("openai-responses")),
          onStreamEvent: (value: unknown): void => {
            if ((value as { type: string }).type === "response.completed") {
              controller.abort();
            }
          },
        }),
      );
      strictEqual(result.message.stopReason, "aborted");
      deepStrictEqual(result.message.content, [
        { type: "text", text: "你好", textSignature: '{"v":1,"id":"msg_test"}' },
      ]);
      strictEqual(result.message.usage.input, 8);
      deepStrictEqual(
        result.events.map((event: AssistantMessageEvent): string => event.type),
        ["start", "text_start", "text_delta", "text_delta", "text_end", "error"],
      );
    });

    it("请求与响应回调失败发生在 start 前且不重试消费过程", async (): Promise<void> => {
      for (const phase of ["payload", "response"] as const) {
        let requests = 0;
        const result = await collectStream(
          createStream(testModel("openai-responses"), normalizeContext({ messages: [] }), {
            apiKey: "test-key",
            maxRetries: 2,
            fetch: async (): Promise<Response> => {
              requests++;
              return eventResponse(protocolEvents("openai-responses"));
            },
            onPayload: (): void => {
              if (phase === "payload") {
                throw new Error("请求回调失败");
              }
            },
            onResponse: (): void => {
              throw new Error("响应回调失败");
            },
          }),
        );
        strictEqual(requests, phase === "payload" ? 0 : 1);
        strictEqual(result.message.stopReason, "error");
        deepStrictEqual(result.message.content, []);
        deepStrictEqual(
          result.events.map((event: AssistantMessageEvent): string => event.type),
          ["error"],
        );
        match(result.message.errorMessage ?? "", /回调失败/);
      }
    });

    it("文法工具历史重放使用 custom 输入和图片结果引用", async (): Promise<void> => {
      const model = testModel("openai-responses");
      model.compat = { supportsOpenAIGrammarTools: true };
      const tool = testTool({ type: "grammar", variants: { openai_regex: "hello" } });
      const history = historyMessage(model, [
        {
          type: "toolCall",
          id: "call_history|ctc_history",
          name: "echo",
          arguments: { input: "hello" },
        },
      ]);
      let payload: Record<string, unknown> | undefined;
      const result = await collectStream(
        createStream(
          model,
          normalizeContext({
            tools: [tool],
            messages: [
              history,
              {
                role: "toolResult",
                toolCallId: "call_history|ctc_history",
                toolName: "echo",
                isError: false,
                timestamp: 0,
                content: [
                  { type: "text", text: "结果" },
                  { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
                ],
              },
            ],
          }),
          {
            apiKey: "test-key",
            onPayload: (value: unknown): void => {
              payload = structuredClone(value) as Record<string, unknown>;
            },
            fetch: async (): Promise<Response> => eventResponse(protocolEvents("openai-responses")),
          },
        ),
      );
      strictEqual(result.message.stopReason, "stop");
      deepStrictEqual(payload?.tools, [
        {
          type: "custom",
          name: "echo",
          description: "返回输入",
          format: { type: "grammar", syntax: "regex", definition: "hello" },
        },
      ]);
      deepStrictEqual(payload?.input, [
        {
          type: "custom_tool_call",
          id: "ctc_history",
          call_id: "call_history",
          name: "echo",
          input: "hello",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_history",
          output: [
            { type: "input_text", text: "结果" },
            { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aGVsbG8=" },
          ],
        },
      ]);
    });

    it("并发请求的内容、工具参数、用量及终态互相隔离", async (): Promise<void> => {
      const results = await Promise.all(
        ["甲", "乙"].map(
          async (
            input: string,
            index: number,
          ): Promise<Awaited<ReturnType<typeof collectStream>>> => {
            const events = protocolEvents("openai-responses", true);
            const serialized = JSON.stringify(events).replaceAll("你好", input);
            const ownEvents = JSON.parse(serialized) as Record<string, unknown>[];
            ownEvents[ownEvents.length - 1] = terminalEvent({
              usage: {
                input_tokens: 10 + index,
                output_tokens: 3 + index,
                total_tokens: 13 + index * 2,
              },
            });
            return collectStream(
              createStream(testModel("openai-responses"), normalizeContext({ messages: [] }), {
                apiKey: "test-key",
                fetch: async (): Promise<Response> => eventResponse(ownEvents),
              }),
            );
          },
        ),
      );
      for (const [index, result] of results.entries()) {
        const call = result.message.content[0];
        ok(call?.type === "toolCall");
        deepStrictEqual(call.arguments, { input: index === 0 ? "甲" : "乙" });
        strictEqual(result.message.usage.input, 10 + index);
        strictEqual(result.message.usage.output, 3 + index);
        strictEqual(result.message.stopReason, "toolUse");
        strictEqual(result.events.at(-1)?.type, "done");
      }
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

describe("openai-responses 原生选项", (): void => {
  it("响应服务等级优先且缺省回退选项，特殊模型费用倍率保持不变", async (): Promise<void> => {
    for (const [id, requestTier, responseTier, multiplier] of [
      ["test-model", "priority", "flex", 0.5],
      ["test-model", "flex", "priority", 2],
      ["gpt-5.5", "flex", "priority", 2.5],
      ["test-model", "flex", undefined, 0.5],
      ["test-model", "priority", "default", 1],
    ] as const) {
      const model = testModel("openai-responses");
      model.id = id;
      model.cost = { input: 1000000, output: 2000000, cacheRead: 3000000, cacheWrite: 4000000 };
      const result = await collectStream(
        stream(model, normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          serviceTier: requestTier,
          fetch: async (): Promise<Response> =>
            eventResponse([terminalEvent({ service_tier: responseTier })]),
        }),
      );
      deepStrictEqual(result.message.usage.cost, {
        input: 7 * multiplier,
        output: 6 * multiplier,
        cacheRead: 6 * multiplier,
        cacheWrite: 4 * multiplier,
        total: 23 * multiplier,
      });
    }
  });

  it("显式缓存及推理参数遵循兼容配置与采样覆盖规则", async (): Promise<void> => {
    const model = testModel("openai-responses");
    model.reasoning = true;
    model.thinkingLevelMap = { high: "medium" };
    model.compat = { supportsExplicitPromptCacheMode: true, supportsMaxOutputTokens: false };
    for (const retention of ["long", "none"] as const) {
      let payload: Record<string, unknown> | undefined;
      const result = await collectStream(
        stream(model, normalizeContext({ messages: [] }), {
          apiKey: "test-key",
          reasoningEffort: "high",
          reasoningSummary: "concise",
          serviceTier: "flex",
          maxTokens: 20,
          sessionId: "session-test",
          cacheRetention: retention,
          onPayload: (value: unknown): void => {
            payload = structuredClone(value) as Record<string, unknown>;
          },
          fetch: async (): Promise<Response> => eventResponse([terminalEvent()]),
        }),
      );
      strictEqual(result.message.stopReason, "stop");
      deepStrictEqual(payload?.reasoning, { effort: "medium", summary: "concise" });
      deepStrictEqual(payload?.include, ["reasoning.encrypted_content"]);
      deepStrictEqual(
        payload?.prompt_cache_options,
        retention === "long" ? { ttl: "30m" } : { mode: "explicit" },
      );
      strictEqual(payload?.prompt_cache_key, retention === "long" ? "session-test" : undefined);
      strictEqual(payload?.prompt_cache_retention, undefined);
      strictEqual(payload?.max_output_tokens, undefined);
      strictEqual(payload?.service_tier, "flex");
    }
  });
});

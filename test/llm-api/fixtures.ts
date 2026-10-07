import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
} from "../../src/llm-api/types.ts";
import type { AssistantMessageEventStream } from "../../src/llm-api/utils/event-stream.ts";

/**
 * 创建离线协议测试所需的模型。
 * @param api - 使用的协议。
 * @returns 包含有效地址与输出上限的独立模型。
 */
export function testModel<TApi extends Api>(api: TApi): Model<TApi> {
  return { id: "test-model", api, baseUrl: "https://example.test/v1", maxTokens: 8192 };
}

/**
 * 将协议事件编码成 SDK 可读取的 SSE 响应。
 * @param events - 按顺序发送的事件。
 * @returns 离线流响应。
 */
export function eventResponse(events: Record<string, unknown>[]): Response {
  const blocks = events.map((event: Record<string, unknown>): string => {
    const name = typeof event.type === "string" ? `event: ${event.type}\n` : "";
    return `${name}data: ${JSON.stringify(event)}\n\n`;
  });
  return new Response(blocks.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

/**
 * 提供各协议文本或工具参数分片的完整事件序列。
 * @param api - 使用的协议。
 * @param hasTool - 是否生成工具调用。
 * @returns 包含停止事件和 token 用量的协议事件。
 */
export function protocolEvents(api: Api, hasTool: boolean = false): Record<string, unknown>[] {
  if (api === "openai-completions") {
    const deltas = hasTool
      ? [
          {
            tool_calls: [
              {
                index: 0,
                id: "call_test",
                type: "function",
                function: { name: "echo", arguments: '{"input":' },
              },
            ],
          },
          { tool_calls: [{ index: 0, function: { arguments: '"你好"}' } }] },
        ]
      : [{ content: "你" }, { content: "好" }];
    const events = deltas.map((delta: Record<string, unknown>): Record<string, unknown> => ({
      id: "chat_test",
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason: null }],
    }));
    events.push({
      id: "chat_test",
      model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: hasTool ? "tool_calls" : "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    });
    return events;
  }
  if (api === "openai-responses") {
    const item = hasTool
      ? {
          type: "function_call",
          id: "fc_test",
          call_id: "call_test",
          name: "echo",
          arguments: "",
          status: "in_progress",
        }
      : { type: "message", id: "msg_test", role: "assistant", content: [], status: "in_progress" };
    const events: Record<string, unknown>[] = [
      { type: "response.output_item.added", output_index: 0, item },
    ];
    for (const delta of hasTool ? ['{"input":', '"你好"}'] : ["你", "好"]) {
      events.push({
        type: hasTool ? "response.function_call_arguments.delta" : "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta,
      });
    }
    const doneItem = hasTool
      ? { ...item, arguments: '{"input":"你好"}', status: "completed" }
      : {
          ...item,
          content: [{ type: "output_text", text: "你好", annotations: [] }],
          status: "completed",
        };
    events.push({ type: "response.output_item.done", output_index: 0, item: doneItem });
    events.push({
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: [doneItem],
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    return events;
  }
  return [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        model: "test-model",
        usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 2 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: hasTool
        ? { type: "tool_use", id: "call_test", name: "echo", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: hasTool
        ? { type: "input_json_delta", partial_json: '{"input":' }
        : { type: "text_delta", text: "你" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: hasTool
        ? { type: "input_json_delta", partial_json: '"你好"}' }
        : { type: "text_delta", text: "好" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: hasTool ? "tool_use" : "end_turn" },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
}

/**
 * 消费事件流并取得最终消息。
 * @param stream - 要检查的事件流。
 * @returns 完整事件序列与最终消息。
 */
export async function collectStream(
  stream: AssistantMessageEventStream,
): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  const message = await stream.result();
  return { events, message };
}

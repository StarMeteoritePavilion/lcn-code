import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  AssistantMessageFrameEncoder,
  reduceAssistantMessageFrames,
} from "../../../src/ai/utils/assistant-message-frame.ts";
import type { AssistantMessageFrame } from "../../../src/ai/utils/assistant-message-frame.ts";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "../../../src/ai/types.ts";

/**
 * 创建具有独立可变内容和用量的助手消息。
 * @returns 尚未终止的空助手消息。
 */
function emptyMessage(): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    baseUrl: "https://example.test",
    model: "test-model",
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

/**
 * 使用独立编码器把事件转换为非空帧。
 * @param events - 要顺序编码的事件。
 * @returns 可用于回放的帧列表。
 */
function encodeFrames(events: AssistantMessageEvent[]): AssistantMessageFrame[] {
  const encoder = new AssistantMessageFrameEncoder();
  const frames: AssistantMessageFrame[] = [];
  for (const event of events) {
    const frame = encoder.encode(event);
    if (frame !== undefined) {
      frames.push(frame);
    }
  }
  return frames;
}

/**
 * 创建工具调用内容块。
 * @param argumentsValue - 起始参数快照。
 * @returns 独立工具调用。
 */
function toolCall(argumentsValue: ToolCall["arguments"] = {}): ToolCall {
  return { type: "toolCall", id: "call_test", name: "echo", arguments: argumentsValue };
}

describe("AssistantMessageFrameEncoder.encode", (): void => {
  it("排队的文本事件只回放快照外增量且不重复已可见文本", (): void => {
    const partial = emptyMessage();
    partial.content = [{ type: "text", text: "你好", textSignature: "signature" }];
    partial.stopReason = "stop";
    const frames = encodeFrames([
      { type: "start", partial },
      { type: "text_start", contentIndex: 0, partial },
      { type: "text_delta", contentIndex: 0, delta: "你", partial },
      { type: "text_delta", contentIndex: 0, delta: "好世界", partial },
      { type: "text_end", contentIndex: 0, content: "你好世界", partial },
      { type: "done", reason: "stop", message: partial },
    ]);
    deepStrictEqual(
      frames.map((frame: AssistantMessageFrame): string => frame.type),
      ["start", "text_start", "text_delta", "text_end"],
    );
    deepStrictEqual(frames[2], { type: "text_delta", contentIndex: 0, delta: "世界" });
    const reduced = reduceAssistantMessageFrames(frames);
    deepStrictEqual(reduced?.content, [
      { type: "text", text: "你好世界", textSignature: "signature" },
    ]);
    strictEqual(reduced?.stopReason, "pending");
  });

  it("start 消息元数据深拷贝并排除已生成内容及终止信息", (): void => {
    const partial = emptyMessage();
    partial.content = [{ type: "text", text: "排队内容" }];
    partial.stopReason = "error";
    partial.errorMessage = "错误";
    partial.responseId = "response_test";
    partial.responseModel = "concrete-model";
    partial.thinkingEffort = "high";
    const encoder = new AssistantMessageFrameEncoder();
    const frame = encoder.encode({ type: "start", partial });
    ok(frame?.type === "start");
    deepStrictEqual(frame.partial.content, []);
    strictEqual(frame.partial.stopReason, "pending");
    strictEqual(frame.partial.errorMessage, undefined);
    strictEqual(frame.partial.responseId, "response_test");
    strictEqual(frame.partial.thinkingEffort, "high");
    partial.usage.input = 100;
    strictEqual(frame.partial.usage.input, 0);
  });

  it("思考增量去重并保留结束签名及隐藏状态", (): void => {
    const partial = emptyMessage();
    partial.content = [
      { type: "thinking", thinking: "已有", thinkingSignature: "encrypted", redacted: true },
    ];
    const frames = encodeFrames([
      { type: "start", partial },
      { type: "thinking_start", contentIndex: 0, partial },
      { type: "thinking_delta", contentIndex: 0, delta: "已有新增", partial },
      { type: "thinking_end", contentIndex: 0, content: "已有新增", partial },
    ]);
    deepStrictEqual(frames[2], { type: "thinking_delta", contentIndex: 0, delta: "新增" });
    const reduced = reduceAssistantMessageFrames(frames);
    deepStrictEqual(reduced?.content, [
      { type: "thinking", thinking: "已有新增", thinkingSignature: "encrypted", redacted: true },
    ]);
  });

  it("工具增量追上初始快照时生成 checkpoint 并保留最终调用元数据", (): void => {
    const partial = emptyMessage();
    const call = toolCall({ input: "你" });
    partial.content = [call];
    const finalCall: ToolCall = {
      ...call,
      id: "final_call",
      name: "final_echo",
      namespace: "tools",
      arguments: { input: "你好" },
    };
    const frames = encodeFrames([
      { type: "start", partial },
      { type: "toolcall_start", contentIndex: 0, partial },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"input":', partial },
      { type: "toolcall_delta", contentIndex: 0, delta: '"你', partial },
      { type: "toolcall_delta", contentIndex: 0, delta: '好"}', partial },
      { type: "toolcall_end", contentIndex: 0, toolCall: finalCall, partial },
    ]);
    deepStrictEqual(frames[2], {
      type: "toolcall_checkpoint",
      contentIndex: 0,
      json: '{"input":"你',
    });
    strictEqual(frames[3]?.type, "toolcall_delta");
    const reduced = reduceAssistantMessageFrames(frames);
    deepStrictEqual(reduced?.content, [finalCall]);
    finalCall.arguments.input = "已修改";
    const last = frames.at(-1);
    ok(last?.type === "toolcall_end");
    deepStrictEqual(last.arguments, { input: "你好" });
  });

  it("初始空工具参数允许直接增量，空增量不生成帧", (): void => {
    const partial = emptyMessage();
    partial.content = [toolCall()];
    const encoder = new AssistantMessageFrameEncoder();
    encoder.encode({ type: "start", partial });
    encoder.encode({ type: "toolcall_start", contentIndex: 0, partial });
    strictEqual(
      encoder.encode({ type: "toolcall_delta", contentIndex: 0, delta: "", partial }),
      undefined,
    );
    deepStrictEqual(
      encoder.encode({
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"input":"你好"}',
        partial,
      }),
      { type: "toolcall_delta", contentIndex: 0, delta: '{"input":"你好"}' },
    );
  });

  it("错误可在 start 前终止，done 必须在 start 后且终止后禁止事件", (): void => {
    const partial = emptyMessage();
    const errorEncoder = new AssistantMessageFrameEncoder();
    strictEqual(errorEncoder.encode({ type: "error", reason: "error", error: partial }), undefined);
    throws((): void => {
      errorEncoder.encode({ type: "start", partial });
    }, /terminal event/);
    const doneEncoder = new AssistantMessageFrameEncoder();
    throws((): void => {
      doneEncoder.encode({ type: "done", reason: "stop", message: partial });
    }, /before start/);
    doneEncoder.encode({ type: "start", partial });
    strictEqual(doneEncoder.encode({ type: "done", reason: "stop", message: partial }), undefined);
    throws((): void => {
      doneEncoder.encode({ type: "start", partial });
    }, /terminal event/);
  });

  it("拒绝 start 前内容、重复 start 与未开始块的增量", (): void => {
    const partial = emptyMessage();
    const encoder = new AssistantMessageFrameEncoder();
    throws((): void => {
      encoder.encode({ type: "text_delta", contentIndex: 0, delta: "你", partial });
    }, /before start/);
    encoder.encode({ type: "start", partial });
    throws((): void => {
      encoder.encode({ type: "start", partial });
    }, /more than one start/);
    throws((): void => {
      encoder.encode({ type: "text_delta", contentIndex: 0, delta: "你", partial });
    }, /has not started/);
  });

  it("拒绝非法索引、缺少内容以及内容类型不匹配", (): void => {
    for (const contentIndex of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const encoder = new AssistantMessageFrameEncoder();
      const partial = emptyMessage();
      encoder.encode({ type: "start", partial });
      throws((): void => {
        encoder.encode({ type: "text_start", contentIndex, partial });
      }, /Invalid.*contentIndex/);
    }
    const encoder = new AssistantMessageFrameEncoder();
    const partial = emptyMessage();
    encoder.encode({ type: "start", partial });
    throws((): void => {
      encoder.encode({ type: "text_start", contentIndex: 0, partial });
    }, /no content block/);
    partial.content = [{ type: "thinking", thinking: "推理" }];
    throws((): void => {
      encoder.encode({ type: "text_start", contentIndex: 0, partial });
    }, /points to thinking/);
    encoder.encode({ type: "thinking_start", contentIndex: 0, partial });
    throws((): void => {
      encoder.encode({ type: "text_delta", contentIndex: 0, delta: "你", partial });
    }, /not text/);
  });

  it("内容块不得重复开始，包括结束后再次使用相同索引", (): void => {
    const encoder = new AssistantMessageFrameEncoder();
    const partial = emptyMessage();
    partial.content = [{ type: "text", text: "" }];
    encoder.encode({ type: "start", partial });
    encoder.encode({ type: "text_start", contentIndex: 0, partial });
    throws((): void => {
      encoder.encode({ type: "text_start", contentIndex: 0, partial });
    }, /starts more than once/);
    encoder.encode({ type: "text_end", contentIndex: 0, content: "", partial });
    throws((): void => {
      encoder.encode({ type: "text_delta", contentIndex: 0, delta: "结束后增量", partial });
    }, /has not started/);
    throws((): void => {
      encoder.encode({ type: "text_start", contentIndex: 0, partial });
    }, /starts more than once/);
  });

  it("拒绝无法序列化的工具快照参数", (): void => {
    const encoder = new AssistantMessageFrameEncoder();
    const partial = emptyMessage();
    partial.content[0] = {
      ...toolCall(),
      arguments: undefined as unknown as ToolCall["arguments"],
    };
    encoder.encode({ type: "start", partial });
    throws((): void => {
      encoder.encode({ type: "toolcall_start", contentIndex: 0, partial });
    }, /not JSON-serializable/);
  });
});

describe("reduceAssistantMessageFrames", (): void => {
  it("重建文本及思考并以结束帧的内容与签名为准", (): void => {
    const frames: AssistantMessageFrame[] = [
      { type: "start", partial: emptyMessage() },
      {
        type: "text_start",
        contentIndex: 0,
        content: { type: "text", text: "", textSignature: "old" },
      },
      { type: "text_delta", contentIndex: 0, delta: "初始" },
      { type: "text_end", contentIndex: 0, content: "最终", textSignature: "new" },
      {
        type: "thinking_start",
        contentIndex: 1,
        content: { type: "thinking", thinking: "", thinkingSignature: "old", redacted: true },
      },
      { type: "thinking_delta", contentIndex: 1, delta: "推理" },
      { type: "thinking_end", contentIndex: 1, content: "最终推理" },
    ];
    const original = structuredClone(frames);
    const result = reduceAssistantMessageFrames(frames);
    deepStrictEqual(result?.content, [
      { type: "text", text: "最终", textSignature: "new" },
      { type: "thinking", thinking: "最终推理" },
    ]);
    deepStrictEqual(frames, original);
  });

  it("未结束工具调用根据 checkpoint 和后续不完整 JSON 重建参数", (): void => {
    const frames: AssistantMessageFrame[] = [
      { type: "start", partial: emptyMessage() },
      { type: "toolcall_start", contentIndex: 0, toolCall: toolCall({ input: "旧" }) },
      { type: "toolcall_checkpoint", contentIndex: 0, json: '{"input":"你' },
      { type: "toolcall_delta", contentIndex: 0, delta: "好" },
    ];
    const result = reduceAssistantMessageFrames(frames);
    deepStrictEqual(result?.content, [toolCall({ input: "你好" })]);
  });

  it("工具结束帧覆盖增量结果并清除过期 namespace", (): void => {
    const frames: AssistantMessageFrame[] = [
      { type: "start", partial: emptyMessage() },
      { type: "toolcall_start", contentIndex: 0, toolCall: { ...toolCall(), namespace: "old" } },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"input":"初始"}' },
      {
        type: "toolcall_end",
        contentIndex: 0,
        id: "final",
        name: "finished",
        arguments: { input: "最终" },
      },
    ];
    const result = reduceAssistantMessageFrames(frames);
    deepStrictEqual(result?.content, [
      { type: "toolCall", id: "final", name: "finished", arguments: { input: "最终" } },
    ]);
  });

  it("空帧、缺少 start 帧返回 undefined，只有 start 可重建空消息", (): void => {
    strictEqual(reduceAssistantMessageFrames([]), undefined);
    strictEqual(
      reduceAssistantMessageFrames([{ type: "text_delta", contentIndex: 0, delta: "你" }]),
      undefined,
    );
    const partial = emptyMessage();
    const result = reduceAssistantMessageFrames([{ type: "start", partial }]);
    deepStrictEqual(result, partial);
    result!.usage.input = 1;
    strictEqual(partial.usage.input, 0);
  });

  it("拒绝重复 start 和内容帧出现在 start 前", (): void => {
    const start: AssistantMessageFrame = { type: "start", partial: emptyMessage() };
    throws((): void => {
      reduceAssistantMessageFrames([start, start]);
    }, /more than one start/);
    throws((): void => {
      reduceAssistantMessageFrames([{ type: "text_delta", contentIndex: 0, delta: "你" }, start]);
    }, /before the start/);
  });

  it("拒绝非法索引、索引空洞和重复块", (): void => {
    for (const contentIndex of [-1, 0.5, Number.NaN, 1]) {
      const start: AssistantMessageFrame = { type: "start", partial: emptyMessage() };
      throws((): void => {
        reduceAssistantMessageFrames([
          start,
          { type: "text_start", contentIndex, content: { type: "text", text: "" } },
        ]);
      }, /contentIndex|gap/);
    }
    const start: AssistantMessageFrame = { type: "start", partial: emptyMessage() };
    const block: AssistantMessageFrame = {
      type: "text_start",
      contentIndex: 0,
      content: { type: "text", text: "" },
    };
    throws((): void => {
      reduceAssistantMessageFrames([start, block, block]);
    }, /already exists/);
  });

  it("拒绝未开始、类型不符和已结束内容块的增量", (): void => {
    const start: AssistantMessageFrame = { type: "start", partial: emptyMessage() };
    const block: AssistantMessageFrame = {
      type: "text_start",
      contentIndex: 0,
      content: { type: "text", text: "" },
    };
    throws((): void => {
      reduceAssistantMessageFrames([start, { type: "text_delta", contentIndex: 0, delta: "你" }]);
    }, /no started block/);
    throws((): void => {
      reduceAssistantMessageFrames([
        start,
        block,
        { type: "thinking_delta", contentIndex: 0, delta: "推理" },
      ]);
    }, /expected thinking/);
    throws((): void => {
      reduceAssistantMessageFrames([
        start,
        block,
        { type: "text_end", contentIndex: 0, content: "" },
        { type: "text_delta", contentIndex: 0, delta: "你" },
      ]);
    }, /follows the end/);
  });

  it("外部传入错误类型的块起始帧时报错", (): void => {
    const invalidFrame = {
      type: "text_start",
      contentIndex: 0,
      content: { type: "thinking", thinking: "推理" },
    } as unknown as AssistantMessageFrame;
    const start: AssistantMessageFrame = { type: "start", partial: emptyMessage() };
    throws((): void => {
      reduceAssistantMessageFrames([start, invalidFrame]);
    }, /contains thinking/);
  });
});

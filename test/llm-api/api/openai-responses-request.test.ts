import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { Type } from "typebox";
import {
  buildParams,
  encodeTextSignatureV1,
} from "../../../src/llm-api/api/openai-responses-request.ts";

import type { AssistantMessage, OpenAIResponsesCompat, Tool } from "../../../src/llm-api/types.ts";
import { normalizeContext } from "../../../src/llm-api/utils/transcript.ts";
import { testModel } from "../fixtures.ts";

const COMPAT: Required<OpenAIResponsesCompat> = {
  supportsDeveloperRole: true,
  supportsMidConvoSystemMessages: false,
  sessionAffinityFormat: "openai",
  supportsLongCacheRetention: true,
  supportsStrictMode: false,
  supportsOpenAIGrammarTools: false,
  supportsAdditionalTools: false,
  supportsToolSearch: false,
  supportsExplicitPromptCacheMode: false,
  supportsMaxOutputTokens: true,
};

/**
 * 创建携带文本签名的历史会话。
 * @param signature - 文本块的协议签名。
 * @returns 可直接用于请求构建的规范会话。
 */
function signedContext(signature?: string): ReturnType<typeof normalizeContext> {
  const model = testModel("openai-responses");
  const message: AssistantMessage = {
    role: "assistant",
    api: model.api,
    baseUrl: model.baseUrl,
    model: model.id,
    content: [{ type: "text", text: "历史文本", textSignature: signature }],
    timestamp: 0,
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  return normalizeContext({ messages: [message] });
}

describe("encodeTextSignatureV1", (): void => {
  it("保留消息标识和消息阶段", (): void => {
    const signature = encodeTextSignatureV1("msg_test", "commentary");
    deepStrictEqual(JSON.parse(signature), { v: 1, id: "msg_test", phase: "commentary" });
  });
  it("空标识和缺省阶段仍生成合法签名", (): void => {
    strictEqual(encodeTextSignatureV1(""), '{"v":1,"id":""}');
  });
  it("引号和换行标识正确转义并可还原", (): void => {
    const signature = encodeTextSignatureV1('msg_"\n');
    deepStrictEqual(JSON.parse(signature), { v: 1, id: 'msg_"\n' });
  });
  it("运行时传入无法序列化的标识时传播原异常", (): void => {
    throws((): void => {
      Reflect.apply(encodeTextSignatureV1, undefined, [1n]);
    }, TypeError);
  });
});

describe("buildParams", (): void => {
  it("构建用户输入、缓存与思考参数并保持采样覆盖优先级", (): void => {
    const model = testModel("openai-responses");
    model.reasoning = true;
    const params = buildParams(
      model,
      normalizeContext({ messages: [{ role: "user", content: "你好", timestamp: 0 }] }),
      {
        apiKey: "test-key",
        maxTokens: 1,
        reasoningEffort: "high",
        cacheRetention: "long",
        sessionId: "session-test",
        temperature: 0.2,
        samplingParams: { temperature: 0.8 },
      },
      COMPAT,
      new Map(),
    );
    deepStrictEqual(params.input, [
      { role: "user", content: [{ type: "input_text", text: "你好" }] },
    ]);
    strictEqual(params.max_output_tokens, 16);
    strictEqual(params.prompt_cache_key, "session-test");
    strictEqual(params.prompt_cache_retention, "24h");
    strictEqual(params.temperature, 0.8);
    deepStrictEqual(params.reasoning, { effort: "high", summary: "auto" });
    deepStrictEqual(params.include, ["reasoning.encrypted_content"]);
  });

  it("空会话与禁用缓存不写入工具、输出上限和缓存键", (): void => {
    const params = buildParams(
      testModel("openai-responses"),
      normalizeContext({ messages: [] }),
      {
        apiKey: "test-key",
        cacheRetention: "none",
        sessionId: "session-test",
      },
      COMPAT,
      new Map(),
    );
    deepStrictEqual(params.input, []);
    strictEqual(params.tools, undefined);
    strictEqual(params.max_output_tokens, undefined);
    strictEqual(params.prompt_cache_key, undefined);
    strictEqual(params.prompt_cache_retention, undefined);
  });

  it("签名重放支持 V1、旧格式、空值与损坏 JSON 降级", (): void => {
    for (const [signature, id, phase] of [
      ['{"v":1,"id":"msg_test","phase":"final_answer"}', "msg_test", "final_answer"],
      ["msg_old", "msg_old", undefined],
      [undefined, "msg_pi_0", undefined],
      ["", "msg_pi_0", undefined],
      ['{"v":1,"id":"msg_test","phase":"other"}', "msg_test", undefined],
      ['{"v":1', '{"v":1', undefined],
      ['{"v":2,"id":"msg_test"}', '{"v":2,"id":"msg_test"}', undefined],
      ['{"v":1,"id":1}', '{"v":1,"id":1}', undefined],
    ] as const) {
      const params = buildParams(
        testModel("openai-responses"),
        signedContext(signature),
        { apiKey: "test-key" },
        COMPAT,
        new Map(),
      );
      deepStrictEqual(params.input, [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "历史文本", annotations: [] }],
          status: "completed",
          id,
          phase,
        },
      ]);
    }
  });

  it("严格约束在端点不支持时拒绝，损坏思考签名原样抛出", (): void => {
    const tool: Tool = {
      name: "echo",
      description: "返回输入",
      parameters: Type.Object({ input: Type.String() }),
      constrainedSampling: { type: "json_schema", strict: "require" },
    };
    throws((): void => {
      buildParams(
        testModel("openai-responses"),
        normalizeContext({ messages: [], tools: [tool] }),
        { apiKey: "test-key" },
        COMPAT,
        new Map(),
      );
    }, /strict/);
    const context = signedContext();
    const message = context.messages[0];
    if (message?.role !== "assistant") {
      throw new Error("历史消息类型不符");
    }
    message.content = [{ type: "thinking", thinking: "思考", thinkingSignature: "{" }];
    throws((): void => {
      buildParams(
        testModel("openai-responses"),
        context,
        { apiKey: "test-key" },
        COMPAT,
        new Map(),
      );
    }, SyntaxError);
  });

  it("客户端工具搜索在系统更新位置新增可延迟加载的工具", (): void => {
    const tool: Tool = {
      name: "echo",
      description: "返回输入",
      parameters: Type.Object({ input: Type.String() }),
    };
    const model = testModel("openai-responses");
    model.compat = { supportsMidConvoSystemMessages: true, supportsToolSearch: true };
    const context = normalizeContext({
      messages: [
        { role: "system", content: "初始", timestamp: 0 },
        { role: "user", content: "提问", timestamp: 0 },
        { role: "system", content: "新增", toolsAdded: [tool], timestamp: 0 },
      ],
    });
    const params = buildParams(
      model,
      context,
      { apiKey: "test-key" },
      { ...COMPAT, supportsToolSearch: true },
      new Map(),
    );
    const input = params.input;
    ok(Array.isArray(input));
    const call = input[2];
    const output = input[3];
    ok(call && "type" in call && call.type === "tool_search_call");
    ok(output && "type" in output && output.type === "tool_search_output");
    strictEqual(params.tools, undefined);
    strictEqual(call.type, "tool_search_call");
    deepStrictEqual(call.arguments, { query: "echo", limit: 1 });
    strictEqual(call.status, "completed");
    strictEqual(call.execution, "client");
    strictEqual(output.type, "tool_search_output");
    strictEqual(output.call_id, call.call_id);
    deepStrictEqual(output.tools, [
      {
        type: "function",
        name: "echo",
        description: "返回输入",
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
        defer_loading: true,
      },
    ]);
  });
});

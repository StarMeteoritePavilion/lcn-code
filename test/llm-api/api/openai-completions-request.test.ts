import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  appendOpenAIReasoningDetail,
  buildParams,
  isOpenAIReasoningDetail,
  type ResolvedOpenAICompletionsCompat,
} from "../../../src/llm-api/api/openai-completions-request.ts";
import { normalizeContext } from "../../../src/llm-api/utils/transcript.ts";
import { testModel } from "../fixtures.ts";
import { tool } from "../helpers.ts";

function compat(): ResolvedOpenAICompletionsCompat {
  return {
    supportsStore: true,
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    maxTokensField: "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: false,
    thinkingFormat: "openai",
    openRouterRouting: {},
    vercelGatewayRouting: undefined,
    chatTemplateKwargs: {},
    chatTemplateArgs: {},
    zaiToolStream: false,
    supportsThinkingTokenBudget: false,
    thinkingTokenBudgetField: undefined,
    supportsStrictMode: false,
    supportsOpenAIGrammarTools: false,
    supportsMidConvoSystemMessages: false,
    supportsMidConvoToolAdditions: false,
    cacheControlFormat: undefined,
    sendSessionAffinityHeaders: false,
    sessionAffinityFormat: "openai",
    supportsLongCacheRetention: true,
    vllmPriority: undefined,
  };
}

describe("buildParams", (): void => {
  it("构建模型消息工具和最大输出字段", (): void => {
    const context = normalizeContext({
      systemPrompt: "系统提示",
      tools: [tool("echo")],
      messages: [{ role: "user", content: "问题", timestamp: 0 }],
    });
    const result = buildParams(
      testModel("openai-completions"),
      context,
      { apiKey: "test-key", maxTokens: 128 },
      compat(),
      "none",
      new Map(),
    );
    deepStrictEqual(result.messages, [
      { role: "system", content: "系统提示" },
      { role: "user", content: "问题" },
    ]);
    strictEqual(result.tools?.length, 1);
    strictEqual(result.max_completion_tokens, 128);
    strictEqual(result.store, false);
    deepStrictEqual(result.stream_options, { include_usage: true });
  });

  it("空会话没有工具和缓存字段且温度零保留", (): void => {
    const result = buildParams(
      testModel("openai-completions"),
      normalizeContext({ messages: [] }),
      { apiKey: "test-key", temperature: 0 },
      compat(),
      "none",
      new Map(),
    );
    deepStrictEqual(result.messages, []);
    strictEqual(result.tools, undefined);
    strictEqual(result.prompt_cache_key, undefined);
    strictEqual(result.prompt_cache_retention, undefined);
    strictEqual(result.temperature, 0);
  });

  it("严格工具要求不被端点支持时抛出原错误", (): void => {
    const strictTool = {
      ...tool(),
      constrainedSampling: { type: "json_schema" as const, strict: "require" as const },
    };
    const context = normalizeContext({ messages: [], tools: [strictTool] });
    const model = testModel("openai-completions");
    const config = compat();
    throws((): void => {
      buildParams(model, context, { apiKey: "test-key" }, config, "none", new Map());
    }, /strict/);
  });
});

describe("isOpenAIReasoningDetail", (): void => {
  it("接受三种推理数据类型及合法公共字段", (): void => {
    for (const detail of [
      { type: "reasoning.summary", summary: "摘要", id: null },
      { type: "reasoning.text", text: "思考", signature: null, index: 0, format: "test" },
      { type: "reasoning.encrypted", data: "密文" },
    ]) {
      strictEqual(isOpenAIReasoningDetail(detail), true);
    }
  });
  it("空值和空对象不是推理数据", (): void => {
    for (const detail of [undefined, null, [], {}]) {
      strictEqual(isOpenAIReasoningDetail(detail), false);
    }
  });
  it("拒绝错误公共字段正文和签名类型", (): void => {
    for (const detail of [
      { type: "reasoning.text", text: 1 },
      { type: "reasoning.text", text: "", signature: 1 },
      { type: "reasoning.summary", summary: "", id: 1 },
      { type: "reasoning.encrypted", data: "", index: "0" },
      { type: "reasoning.summary", summary: "", format: false },
      { type: "unknown", text: "" },
    ]) {
      strictEqual(isOpenAIReasoningDetail(detail), false);
    }
  });
});

describe("appendOpenAIReasoningDetail", (): void => {
  it("合并相邻文本及摘要并保留首次非空签名", (): void => {
    const details: Parameters<typeof appendOpenAIReasoningDetail>[0] = [];
    appendOpenAIReasoningDetail(details, {
      type: "reasoning.text",
      text: "甲",
      signature: "首签名",
    });
    appendOpenAIReasoningDetail(details, {
      type: "reasoning.text",
      text: "乙",
      signature: "后签名",
      id: "r1",
    });
    appendOpenAIReasoningDetail(details, { type: "reasoning.summary", summary: "概" });
    appendOpenAIReasoningDetail(details, { type: "reasoning.summary", summary: "述", index: 2 });
    deepStrictEqual(details, [
      {
        type: "reasoning.text",
        text: "甲乙",
        signature: "首签名",
        id: "r1",
        format: undefined,
        index: undefined,
      },
      { type: "reasoning.summary", summary: "概述", id: undefined, format: undefined, index: 2 },
    ]);
  });
  it("空列表追加浅拷贝且加密条目始终独立保存", (): void => {
    const details: Parameters<typeof appendOpenAIReasoningDetail>[0] = [];
    const detail: Parameters<typeof appendOpenAIReasoningDetail>[1] = {
      type: "reasoning.encrypted",
      data: "",
    };
    appendOpenAIReasoningDetail(details, detail);
    appendOpenAIReasoningDetail(details, detail);
    deepStrictEqual(details, [detail, detail]);
    strictEqual(details[0] === detail, false);
    strictEqual(details[0] === details[1], false);
  });
  it("无法修改冻结列表时传播异常", (): void => {
    const details: Parameters<typeof appendOpenAIReasoningDetail>[0] = [];
    Object.freeze(details);
    throws((): void => {
      appendOpenAIReasoningDetail(details, { type: "reasoning.encrypted", data: "密文" });
    }, TypeError);
  });
});

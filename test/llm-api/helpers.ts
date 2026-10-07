import { Type } from "typebox";
import type { AssistantMessage, Model, Tool } from "../../src/llm-api/types.ts";

/**
 * 创建无网络依赖的模型，允许测试按需覆盖字段。
 * @param overrides - 当前场景的模型字段。
 * @returns 独立的模型对象。
 */
export function model(overrides: Partial<Model> = {}): Model {
  return {
    api: "openai-completions",
    id: "测试模型",
    baseUrl: "https://example.test/v1",
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  };
}

/**
 * 创建具有完整用量结构的助手消息。
 * @param overrides - 当前场景的消息字段。
 * @returns 独立的助手消息。
 */
export function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    baseUrl: "https://example.test/v1",
    model: "测试模型",
    content: [{ type: "text", text: "回答" }],
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}

/**
 * 创建参数为数字 value 的工具声明。
 * @param name - 精确工具名称。
 * @returns 新的工具声明。
 */
export function tool(name: string = "测试工具"): Tool {
  return {
    name,
    description: "测试工具说明",
    parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
  };
}

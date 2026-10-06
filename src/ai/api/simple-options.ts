import { clampThinkingLevel } from "../models.ts";
import type {
  Api,
  Model,
  ModelThinkingLevel,
  SamplingParams,
  SimpleStreamOptions,
  StreamOptions,
  ThinkingBudgets,
  ThinkingLevel,
  TranscriptContext,
} from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;

/**
 * 将最大输出 token 数限制在模型上下文窗口的剩余空间内。
 * @param model - 目标模型。
 * @param context - 本次请求的会话上下文，用于估算已占用的 token。
 * @param maxTokens - 期望的最大输出 token 数。
 * @returns 限制后的最大输出 token 数，至少为 1。
 * @remarks 剩余空间 = 上下文窗口 − 估算上下文 token − 4096 安全余量；模型未声明有效上下文窗口时仅保证结果不小于 1。
 */
export function clampMaxTokensToContext(
  model: Model<Api>,
  context: TranscriptContext,
  maxTokens: number,
): number {
  if (model.contextWindow === undefined || model.contextWindow <= 0) {
    return Math.max(MIN_MAX_TOKENS, maxTokens);
  }
  const available =
    model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
  return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

/**
 * 合并模型默认、思考级别专属与请求级的采样参数。
 * @param model - 目标模型。
 * @param thinkingLevel - 请求的思考级别，会先按模型支持的级别进行钳制。
 * @param requestParams - 请求中显式指定的采样参数。
 * @returns 合并后的采样参数，优先级为请求级 > 思考级别专属 > 模型默认；三者均未提供时返回 undefined。
 */
export function resolveSamplingParams(
  model: Model<Api>,
  thinkingLevel: ModelThinkingLevel,
  requestParams?: SamplingParams,
): SamplingParams | undefined {
  const effectiveThinkingLevel = clampThinkingLevel(model, thinkingLevel);
  const thinkingLevelParams = model.samplingParamsByThinkingLevel?.[effectiveThinkingLevel];
  return model.samplingParams || thinkingLevelParams || requestParams
    ? { ...model.samplingParams, ...thinkingLevelParams, ...requestParams }
    : undefined;
}

/**
 * 由简化流式选项构建提供方通用的基础流式选项。
 * @param model - 目标模型。
 * @param context - 本次请求的会话上下文，用于限制最大输出 token 数。
 * @param options - 调用方传入的简化流式选项。
 * @returns 基础流式选项：采样参数按 `options.reasoning`（默认 `"off"`）解析；`maxTokens` 取请求值或模型值并按上下文剩余空间限制，两者均未提供时为 undefined；其余字段原样透传。
 */
export function buildBaseOptions(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions,
): StreamOptions {
  const samplingParams = resolveSamplingParams(
    model,
    options?.reasoning ?? "off",
    options?.samplingParams,
  );
  return {
    temperature: options?.temperature,
    samplingParams,
    maxTokens:
      options.maxTokens === undefined && model.maxTokens === undefined
        ? undefined
        : clampMaxTokensToContext(model, context, options.maxTokens ?? model.maxTokens!),
    signal: options?.signal,
    apiKey: options.apiKey,
    env: options.env,
    fetch: options?.fetch,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    onStreamEvent: options?.onStreamEvent,
    onProviderStreamEvent: options?.onProviderStreamEvent,
    timeoutMs: options?.timeoutMs,
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
  };
}

/**
 * 思考预算与回答共享响应上限时，始终为回答保留的 token 数。
 */
const MIN_ANSWER_TOKENS = 1024;

/** 各思考级别默认的思考 token 预算。 */
const DEFAULT_THINKING_BUDGETS: ThinkingBudgets = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
};

/**
 * 将思考级别钳制到预算表支持的范围内。
 * @param effort - 请求的思考级别。
 * @returns `"xhigh"` 与 `"max"` 映射为 `"high"`，其他级别原样返回；未提供时返回 undefined。
 */
function clampReasoning(
  effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/**
 * 获取指定思考级别对应的思考 token 预算。
 * @param reasoningLevel - 思考级别，`"xhigh"` 与 `"max"` 按 `"high"` 处理。
 * @param customBudgets - 自定义预算，按级别覆盖 `DEFAULT_THINKING_BUDGETS` 中的默认值。
 * @returns 该级别的思考 token 预算。
 */
export function thinkingBudgetForLevel(
  reasoningLevel: ThinkingLevel,
  customBudgets?: ThinkingBudgets,
): number {
  const budgets = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };
  const level = clampReasoning(reasoningLevel)!;
  return budgets[level]!;
}

/**
 * 限制思考预算，使共享的响应上限中至少为回答保留 `MIN_ANSWER_TOKENS` 个 token。
 * @param thinkingBudget - 原始思考 token 预算。
 * @param ceiling - 思考与回答共享的响应 token 上限。
 * @returns 不超过 `ceiling - MIN_ANSWER_TOKENS` 的思考预算，最小为 0。
 */
export function clampThinkingBudgetToAnswerRoom(thinkingBudget: number, ceiling: number): number {
  return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}

/**
 * 为启用思考的请求计算最大输出 token 数与思考预算。
 * @param baseMaxTokens - 调用方期望的回答 token 上限；undefined 表示未显式限制，直接使用模型上限并在其中容纳思考预算。
 * @param modelMaxTokens - 模型允许的最大输出 token 数。
 * @param reasoningLevel - 思考级别。
 * @param customBudgets - 自定义思考预算，覆盖默认值。
 * @returns `maxTokens` 为 `baseMaxTokens + 思考预算`（不超过模型上限）或模型上限；当 `maxTokens` 不大于思考预算时，`thinkingBudget` 会被压缩以为回答保留空间。
 */
export function adjustMaxTokensForThinking(
  // undefined 表示调用方未显式限制输出；采用模型上限，并在其中容纳思考预算。
  baseMaxTokens: number | undefined,
  modelMaxTokens: number,
  reasoningLevel: ThinkingLevel,
  customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
  let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
  const maxTokens =
    baseMaxTokens === undefined
      ? modelMaxTokens
      : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

  if (maxTokens <= thinkingBudget) {
    thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
  }

  return { maxTokens, thinkingBudget };
}

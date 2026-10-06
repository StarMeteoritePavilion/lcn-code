import type { Api, Model, ModelCostRates, ModelThinkingLevel, Usage } from "./types.ts";

/**
 * 根据模型单价与用量计算费用，并写回 usage.cost。
 * @param model - 提供单价的模型，单价单位为每百万 token。
 * @param usage - token 用量，其 cost 字段会被覆盖。
 * @returns 写入 usage 后的费用对象；模型未配置单价时各项均为 0。
 * @remarks 按输入 token 总数（含缓存读写）选择 inputTokensAbove 最高的匹配阶梯价；1 小时缓存写入按 2 倍输入单价计费。
 */
export function calculateCost(model: Model, usage: Usage): Usage["cost"] {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!model.cost) {
    usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    return usage.cost;
  }
  usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let rates: ModelCostRates = model.cost;
  let matchedThreshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }

  // Anthropic 的 1h 缓存写入按基础输入单价的 2 倍计费。
  const longWrite = usage.cacheWrite1h ?? 0;
  const shortWrite = usage.cacheWrite - longWrite;
  usage.cost.input = (rates.input / 1000000) * usage.input;
  usage.cost.output = (rates.output / 1000000) * usage.output;
  usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
  usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * 获取模型支持的推理级别列表。
 * @param model - 目标模型。
 * @returns 按强度升序排列的级别；模型不支持推理时仅返回 off。
 * @remarks thinkingLevelMap 中映射为 null 的级别被排除；xhigh 与 max 仅在显式映射时可用。
 */
export function getSupportedThinkingLevels<TApi extends Api>(
  model: Model<TApi>,
): ModelThinkingLevel[] {
  if (model.reasoning === false) {
    return ["off"];
  }

  return EXTENDED_THINKING_LEVELS.filter((level: ModelThinkingLevel): boolean => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined;
    }
    return true;
  });
}

/**
 * 将请求的推理级别调整为模型支持的级别。
 * @param model - 用于确定可用推理级别的模型。
 * @param level - 请求的推理级别。
 * @returns 已支持的请求级别，或优先向上、再向下查找的可用级别；无可用级别时返回 off。
 */
export function clampThinkingLevel<TApi extends Api>(
  model: Model<TApi>,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  const availableLevels = getSupportedThinkingLevels(model);
  if (availableLevels.includes(level)) {
    return level;
  }

  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) {
    return availableLevels[0] ?? "off";
  }

  for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
    const availableLevel = EXTENDED_THINKING_LEVELS[i];
    if (availableLevel !== undefined && availableLevels.includes(availableLevel)) {
      return availableLevel;
    }
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const availableLevel = EXTENDED_THINKING_LEVELS[i];
    if (availableLevel !== undefined && availableLevels.includes(availableLevel)) {
      return availableLevel;
    }
  }
  return availableLevels[0] ?? "off";
}

/**
 * 通过比较 api、baseUrl 与 id 判断两个模型是否相同。
 * @param a - 第一个模型，可为空。
 * @param b - 第二个模型，可为空。
 * @returns 三项均相同时为 true；任一模型为 null 或 undefined 时为 false。
 */
export function modelsAreEqual(a: Model | null | undefined, b: Model | null | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return a.api === b.api && a.baseUrl === b.baseUrl && a.id === b.id;
}

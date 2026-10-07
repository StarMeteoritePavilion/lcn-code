import { loadConfig } from "./config.ts";
import { validateAiConfig, type AiConfig, type AiRequestOptions } from "./ai-config-schema.ts";
import type { Model } from "../llm-api/types.ts";

/** 配置读取后选中的运行时模型与请求选项。 */
export interface ResolvedAiConfig {
  model: Model;
  options: AiRequestOptions & { apiKey: string };
}

/**
 * 按配置约定合并请求默认值，特定映射按键覆盖，其他字段整值替换。
 * @param layers - 从低优先级到高优先级的请求选项。
 * @returns 合并后的独立请求选项对象。
 */
function mergeRequestOptions(layers: readonly (AiRequestOptions | undefined)[]): AiRequestOptions {
  const result: Record<string, unknown> = Object.create(null);
  for (const layer of layers) {
    if (!layer) {
      continue;
    }
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) {
        continue;
      }
      if (key === "headers" || key === "samplingParams" || key === "thinkingBudgets") {
        result[key] = { ...(result[key] as object | undefined), ...(value as object) };
      } else {
        result[key] = value;
      }
    }
  }
  return result as AiRequestOptions;
}

/**
 * 读取 settings.json，按精确名称选择提供商与模型并组装请求配置。
 * @param directory - 配置及 .env 所在目录，默认使用调用时的工作目录。
 * @param requestOptions - 本次调用的请求选项，覆盖提供商与模型默认值；apiKey 始终取自提供商。
 * @returns 选中的模型与请求选项，可交给对应协议的 stream 或 complete；简化入口只接受其支持的选项。
 * @throws 文件、环境变量、配置结构、模型选择或必需参数无效时抛出异常。
 * @remarks 未知字段保持 Pi 的宽松校验策略；重复提供商名称和模型 ID 使用后项。自定义模型默认值采用 Pi，不读取内建模型目录，不发起网络请求。
 */
export async function loadAiConfig(
  directory: string = process.cwd(),
  requestOptions?: AiRequestOptions,
): Promise<ResolvedAiConfig> {
  const value = await loadConfig(directory);
  validateAiConfig(value);
  const providers = new Map(
    value.modelProviders.map(
      (provider: AiConfig["modelProviders"][number]): [string, typeof provider] => [
        provider.name,
        provider,
      ],
    ),
  );
  const provider = providers.get(value.provider);
  if (!provider) {
    throw new Error("Configuration provider does not exactly match any modelProviders[].name");
  }
  const models = new Map(
    (provider.models ?? []).map(
      (
        definition: NonNullable<AiConfig["modelProviders"][number]["models"]>[number],
      ): [string, typeof definition] => [definition.id, definition],
    ),
  );
  const definition = models.get(value.model);
  if (!definition) {
    throw new Error(
      "Configuration model does not exactly match any models[].id in the selected provider",
    );
  }
  if (!provider.api) {
    throw new Error("The selected provider must specify api");
  }
  if (!provider.baseUrl?.trim()) {
    throw new Error("The selected provider must specify a non-empty baseUrl");
  }
  if (!provider.apiKey?.trim()) {
    throw new Error("The selected provider must specify a non-empty apiKey");
  }
  if (requestOptions !== undefined) {
    // 合并前校验，避免错误的映射类型被对象展开转换为空对象。
    validateAiConfig({
      provider: value.provider,
      model: value.model,
      modelProviders: [{ ...provider, models: [], requestOptions }],
    });
  }
  const options = mergeRequestOptions([
    provider.requestOptions,
    definition.requestOptions,
    requestOptions,
  ]);
  const model: Model = {
    id: definition.id,
    api: provider.api,
    baseUrl: provider.baseUrl,
    name: definition.name ?? definition.id,
    reasoning: definition.reasoning ?? false,
    thinkingLevelMap: definition.thinkingLevelMap,
    input: definition.input ?? ["text"],
    inputLimits: definition.inputLimits,
    cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    promptCache: definition.promptCache,
    contextWindow: definition.contextWindow ?? 128000,
    maxTokens: definition.maxTokens ?? 16384,
    samplingParams: definition.samplingParams,
    samplingParamsByThinkingLevel: definition.samplingParamsByThinkingLevel,
    headers: definition.headers,
    compat: definition.compat,
  };
  return { model, options: { ...options, apiKey: provider.apiKey } };
}

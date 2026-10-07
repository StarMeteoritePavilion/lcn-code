import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadAiConfig } from "../../src/config/index.ts";
import type { AiRequestOptions } from "../../src/config/ai-config-schema.ts";
import type { Api } from "../../src/llm-api/types.ts";

function createConfig(api: Api = "openai-completions"): Record<string, unknown> {
  return {
    provider: "提供商",
    model: "模型",
    modelProviders: [
      {
        name: "提供商",
        api,
        baseUrl: "https://example.test/v1",
        apiKey: "静态密钥",
        models: [{ id: "模型" }],
      },
    ],
  };
}

/**
 * 将配置写入独立临时目录并检查公开读取接口。
 * @param config - 待写入的 JSON 数据。
 * @param run - 使用临时配置目录的检查函数。
 * @returns 检查完成且临时目录已清理。
 */
async function withConfig(
  config: unknown,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const prefix = join(tmpdir(), "lcn-ai-config-");
  const directory = await mkdtemp(prefix);
  try {
    await writeFile(join(directory, "settings.json"), JSON.stringify(config));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("loadAiConfig", (): void => {
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
    it(`${api} 省略模型参数时采用 Pi 的自定义模型默认值`, async (): Promise<void> => {
      await withConfig(createConfig(api), async (directory: string): Promise<void> => {
        const result = await loadAiConfig(directory);
        strictEqual(result.model.api, api);
        strictEqual(result.model.baseUrl, "https://example.test/v1");
        strictEqual(result.model.name, "模型");
        strictEqual(result.model.reasoning, false);
        deepStrictEqual(result.model.input, ["text"]);
        deepStrictEqual(result.model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        strictEqual(result.model.contextWindow, 128000);
        strictEqual(result.model.maxTokens, 16384);
        deepStrictEqual(result.options, { apiKey: "静态密钥" });
        strictEqual("apiKey" in result.model, false);
        strictEqual("requestOptions" in result.model, false);
      });
    });
  }

  for (const name of ["", " ", "显示名称"]) {
    it(`模型 name 保留显式字符串（长度 ${name.length}）`, async (): Promise<void> => {
      const config = createConfig();
      config.modelProviders = [
        {
          name: "提供商",
          api: "openai-completions",
          baseUrl: "https://example.test/v1",
          apiKey: "静态密钥",
          models: [{ id: "模型", name }],
        },
      ];
      await withConfig(config, async (directory: string): Promise<void> => {
        const result = await loadAiConfig(directory);
        strictEqual(result.model.name, name);
      });
    });
  }

  it("未选中模型同样校验预算范围及名称类型", async (): Promise<void> => {
    for (const definition of [{ contextWindow: 0 }, { maxTokens: -1 }, { name: 1 }]) {
      const config = createConfig();
      config.modelProviders = [
        {
          name: "提供商",
          api: "openai-completions",
          baseUrl: "https://example.test/v1",
          apiKey: "静态密钥",
          models: [{ id: "模型" }, { id: "未选中模型", ...definition }],
        },
      ];
      await withConfig(config, async (directory: string): Promise<void> => {
        await rejects(loadAiConfig(directory), /models\.1\./);
      });
    }
  });

  it("按提供商、模型、本次调用合并映射，其他选项完整替换", async (): Promise<void> => {
    const config = {
      provider: "提供商",
      model: "模型",
      modelProviders: [
        {
          name: "提供商",
          api: "openai-completions",
          baseUrl: "https://example.test",
          apiKey: "密钥",
          requestOptions: {
            headers: { first: "提供商", remove: "默认" },
            samplingParams: { top_p: 0.9, top_k: 10 },
            thinkingBudgets: { low: 2048, high: 16384 },
            metadata: { first: true },
            maxRetries: 2,
          },
          models: [
            {
              id: "模型",
              headers: { model: "模型默认头" },
              requestOptions: {
                headers: { first: "模型", remove: null },
                samplingParams: { top_k: 20 },
                thinkingBudgets: { high: 8192 },
                metadata: { second: true },
              },
            },
          ],
        },
      ],
    };
    await withConfig(config, async (directory: string): Promise<void> => {
      const result = await loadAiConfig(directory, {
        headers: { third: "调用" },
        samplingParams: { top_p: 0.5 },
        thinkingBudgets: { low: 1024 },
        maxRetries: 0,
      });
      deepStrictEqual(result.options, {
        apiKey: "密钥",
        headers: { first: "模型", remove: null, third: "调用" },
        samplingParams: { top_p: 0.5, top_k: 20 },
        thinkingBudgets: { low: 1024, high: 8192 },
        metadata: { second: true },
        maxRetries: 0,
      });
      deepStrictEqual(result.model.headers, { model: "模型默认头" });
      const next = await loadAiConfig(directory);
      strictEqual(next.options.maxRetries, 2);
    });
  });

  it("同名提供商与同 ID 模型采用最后一项，并保留精确大小写", async (): Promise<void> => {
    await withConfig(
      {
        provider: "P",
        model: "M",
        modelProviders: [
          {
            name: "P",
            api: "anthropic-messages",
            baseUrl: "https://old.test",
            apiKey: "旧密钥",
            models: [{ id: "M" }],
          },
          {
            name: "P",
            api: "openai-responses",
            baseUrl: "https://new.test",
            apiKey: "新密钥",
            models: [
              { id: "M", name: "旧名称" },
              { id: "m", name: "不同大小写" },
              { id: "M", name: "新名称", headers: { version: "最后一项" } },
            ],
          },
        ],
      },
      async (directory: string): Promise<void> => {
        const result = await loadAiConfig(directory);
        strictEqual(result.model.api, "openai-responses");
        strictEqual(result.model.name, "新名称");
        strictEqual(result.options.apiKey, "新密钥");
        deepStrictEqual(result.model.headers, { version: "最后一项" });
      },
    );
  });

  it("显式模型值覆盖默认值，允许 Pi 支持的非整数正预算", async (): Promise<void> => {
    await withConfig(
      {
        provider: "P",
        model: "M",
        extra: true,
        modelProviders: [
          {
            name: "P",
            api: "anthropic-messages",
            baseUrl: "https://example.test",
            apiKey: "密钥",
            models: [
              {
                id: "M",
                name: "名称",
                reasoning: true,
                input: [],
                contextWindow: 0.5,
                maxTokens: 0.25,
                compat: { forceAdaptiveThinking: true },
                unknown: "保留但不用",
              },
            ],
          },
        ],
      },
      async (directory: string): Promise<void> => {
        const { model } = await loadAiConfig(directory);
        strictEqual(model.name, "名称");
        strictEqual(model.reasoning, true);
        deepStrictEqual(model.input, []);
        strictEqual(model.contextWindow, 0.5);
        strictEqual(model.maxTokens, 0.25);
        deepStrictEqual(model.compat, { forceAdaptiveThinking: true });
        strictEqual("unknown" in model, false);
      },
    );
  });

  for (const config of [
    {},
    { provider: "P", model: "M", modelProviders: [] },
    { ...createConfig(), provider: "不存在" },
    { ...createConfig(), model: "不存在" },
    { ...createConfig(), provider: "提供商 " },
    {
      provider: "P",
      model: "M",
      modelProviders: [
        { name: "P", api: "openai-completions", apiKey: "密钥", models: [{ id: "M" }] },
      ],
    },
    {
      provider: "P",
      model: "M",
      modelProviders: [
        { name: "P", baseUrl: "https://example.test", apiKey: "密钥", models: [{ id: "M" }] },
      ],
    },
    {
      provider: "P",
      model: "M",
      modelProviders: [
        {
          name: "P",
          api: "openai-completions",
          baseUrl: "https://example.test",
          apiKey: " ",
          models: [{ id: "M" }],
        },
      ],
    },
  ]) {
    it(`缺失必填信息或选择无匹配项时抛出异常（${JSON.stringify(config).length}）`, async (): Promise<void> => {
      await withConfig(config, async (directory: string): Promise<void> => {
        await rejects(loadAiConfig(directory));
      });
    });
  }

  for (const field of ["contextWindow", "maxTokens"] as const) {
    for (const budget of [0, -1]) {
      it(`${field} 为 ${budget} 时按模型配置范围拒绝`, async (): Promise<void> => {
        await withConfig(
          {
            provider: "P",
            model: "M",
            modelProviders: [
              {
                name: "P",
                api: "openai-responses",
                baseUrl: "https://example.test",
                apiKey: "密钥",
                models: [{ id: "M", [field]: budget }],
              },
            ],
          },
          async (directory: string): Promise<void> => {
            await rejects(
              loadAiConfig(directory),
              new RegExp(`models\\.0\\.${field}: exclusiveMinimum`),
            );
          },
        );
      });
    }
  }

  it("本次调用的错误类型同样经过校验", async (): Promise<void> => {
    await withConfig(createConfig(), async (directory: string): Promise<void> => {
      for (const options of [
        { maxRetries: "不是数字" },
        { headers: null },
        { headers: [] },
        { samplingParams: "错误" },
        { thinkingBudgets: 1 },
      ]) {
        const invalid = options as unknown as AiRequestOptions;
        await rejects(loadAiConfig(directory, invalid), /requestOptions/);
      }
    });
  });

  it("配置文件不存在时缺失必填字段，阻止调用", async (): Promise<void> => {
    await withConfig(createConfig(), async (directory: string): Promise<void> => {
      await rm(join(directory, "settings.json"));
      await rejects(loadAiConfig(directory), /provider/);
    });
  });
});

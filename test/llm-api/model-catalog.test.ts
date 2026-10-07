import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  ModelCatalog,
  type ModelCatalogRefreshContext,
  type ModelCatalogSource,
} from "../../src/llm-api/model-catalog.ts";
import { InMemoryModelsStore, type ModelsStore } from "../../src/llm-api/models-store.ts";
import type { Model } from "../../src/llm-api/types.ts";
import { model } from "./helpers.ts";

describe("ModelCatalog 来源与模型查询", (): void => {
  it("默认目录为空，构造时按来源 ID 注册并以最后一项覆盖", (): void => {
    const empty = new ModelCatalog();
    deepStrictEqual(empty.getSources(), []);
    deepStrictEqual(empty.getModels(), []);
    strictEqual(empty.getModel("缺失", "模型"), undefined);
    const first: ModelCatalogSource = {
      id: "来源",
      getModels(): readonly Model[] {
        return [model({ id: "旧模型" })];
      },
    };
    const replacement: ModelCatalogSource = {
      id: "来源",
      getModels(): readonly Model[] {
        return [model({ id: "新模型" })];
      },
    };
    const catalog = new ModelCatalog({ sources: [first, replacement] });
    deepStrictEqual(catalog.getSources(), [replacement]);
    strictEqual(catalog.getModels()[0]?.id, "新模型");
  });

  it("注册保留精确 ID 和顺序，返回的来源数组与内部数组隔离", (): void => {
    const catalog = new ModelCatalog();
    const upper: ModelCatalogSource = {
      id: "A",
      getModels(): readonly Model[] {
        return [];
      },
    };
    const lower: ModelCatalogSource = {
      id: "a",
      getModels(): readonly Model[] {
        return [];
      },
    };
    catalog.setSource(upper);
    catalog.setSource(lower);
    const sources = [...catalog.getSources()];
    sources.pop();
    deepStrictEqual(catalog.getSources(), [upper, lower]);
    catalog.setSource({
      id: "A",
      getModels(): readonly Model[] {
        return [];
      },
    });
    strictEqual(catalog.getSources()[1], lower);
  });

  it("来源 ID 读取失败时构造和注册抛出原错误，不覆盖已有来源", (): void => {
    const error = new Error("来源 ID 无法读取");
    const source: ModelCatalogSource = {
      get id(): string {
        throw error;
      },
      getModels(): readonly Model[] {
        return [];
      },
    };
    throws((): ModelCatalog => new ModelCatalog({ sources: [source] }), error);
    const catalog = new ModelCatalog();
    throws((): void => catalog.setSource(source), error);
    deepStrictEqual(catalog.getSources(), []);
  });

  it("按精确来源和模型 ID 查找，异常来源贡献空列表", (): void => {
    const selected = model({ id: "M" });
    const catalog = new ModelCatalog({
      sources: [
        {
          id: "A",
          getModels(): readonly Model[] {
            return [selected];
          },
        },
        {
          id: "异常",
          getModels(): readonly Model[] {
            throw new Error("读取失败");
          },
        },
      ],
    });
    deepStrictEqual(catalog.getModels(), [selected]);
    deepStrictEqual(catalog.getModels("A"), [selected]);
    deepStrictEqual(catalog.getModels("a"), []);
    deepStrictEqual(catalog.getModels("异常"), []);
    strictEqual(catalog.getModel("A", "M"), selected);
    strictEqual(catalog.getModel("A", "m"), undefined);
    strictEqual(catalog.getModel("异常", "M"), undefined);
  });

  it("删除来源与缺失来源幂等，保留已存储条目", async (): Promise<void> => {
    const store = new InMemoryModelsStore();
    await store.write("来源", { models: [model()] });
    const catalog = new ModelCatalog({
      modelsStore: store,
      sources: [
        {
          id: "来源",
          getModels(): readonly Model[] {
            return [model()];
          },
        },
      ],
    });
    catalog.deleteSource("来源");
    catalog.deleteSource("来源");
    catalog.deleteSource("缺失");
    deepStrictEqual(catalog.getSources(), []);
    strictEqual((await store.read("来源"))?.models.length, 1);
  });
});

describe("ModelCatalog.refresh", (): void => {
  it("默认先离线刷新，提供密钥后联网刷新并仅向联网阶段传递 force", async (): Promise<void> => {
    const contexts: ModelCatalogRefreshContext[] = [];
    const store = new InMemoryModelsStore();
    await store.write("来源", { models: [model()], etag: "缓存版本" });
    const catalog = new ModelCatalog({
      modelsStore: store,
      sources: [
        {
          id: "来源",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(context: ModelCatalogRefreshContext): Promise<void> {
            contexts.push(context);
          },
        },
      ],
    });
    const result = await catalog.refresh({ apiKey: "测试密钥", force: true });
    strictEqual(result.aborted, false);
    strictEqual(result.errors.size, 0);
    deepStrictEqual(
      contexts.map((context: ModelCatalogRefreshContext): boolean => context.allowNetwork),
      [false, true],
    );
    strictEqual(contexts[0]?.force, undefined);
    strictEqual(contexts[1]?.force, true);
    strictEqual(contexts[0]?.stored?.etag, "缓存版本");
    strictEqual(contexts[1]?.apiKey, "测试密钥");
  });

  it("无密钥或显式禁止网络时仅离线刷新，精确选择来源且空列表不刷新", async (): Promise<void> => {
    const calls: boolean[] = [];
    const catalog = new ModelCatalog({
      sources: [
        {
          id: "A",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(context: ModelCatalogRefreshContext): Promise<void> {
            calls.push(context.allowNetwork);
          },
        },
        {
          id: "静态",
          getModels(): readonly Model[] {
            return [];
          },
        },
      ],
    });
    await catalog.refresh();
    await catalog.refresh({ apiKey: "测试密钥", allowNetwork: false, sources: ["A"] });
    await catalog.refresh({ sources: ["a"] });
    await catalog.refresh({ sources: [] });
    deepStrictEqual(calls, [false, false]);
    const empty = new ModelCatalog();
    const result = await empty.refresh();
    strictEqual(result.errors.size, 0);
    strictEqual(result.aborted, false);
  });

  it("离线发布先持久化再更新，联网阶段读到新条目，支持删除和仅更新", async (): Promise<void> => {
    const store = new InMemoryModelsStore();
    const updates: string[] = [];
    const catalog = new ModelCatalog({
      modelsStore: store,
      sources: [
        {
          id: "来源",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(context: ModelCatalogRefreshContext): Promise<void> {
            if (!context.allowNetwork) {
              const accepted = await context.publish({
                persist: { models: [model()], etag: "离线版本" },
                /** 记录离线发布的更新。 */
                update: (): void => {
                  updates.push("离线");
                },
              });
              strictEqual(accepted, true);
              strictEqual((await store.read("来源"))?.etag, "离线版本");
              return;
            }
            strictEqual(context.stored?.etag, "离线版本");
            strictEqual(await context.publish({ persist: null }), true);
            strictEqual(await store.read("来源"), undefined);
            strictEqual(
              await context.publish({
                /** 记录无持久化字段的更新。 */
                update: (): void => {
                  updates.push("联网");
                },
              }),
              true,
            );
          },
        },
      ],
    });
    const result = await catalog.refresh({ apiKey: "测试密钥" });
    strictEqual(result.errors.size, 0);
    deepStrictEqual(updates, ["离线", "联网"]);
  });

  it("来源抛错按 ID 汇总，字符串错误归一化且其他来源继续刷新", async (): Promise<void> => {
    let hasSucceeded = false;
    const error = new Error("来源失败");
    const catalog = new ModelCatalog({
      sources: [
        {
          id: "错误",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(): Promise<void> {
            throw error;
          },
        },
        {
          id: "字符串",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(): Promise<void> {
            throw "字符串错误";
          },
        },
        {
          id: "成功",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(): Promise<void> {
            hasSucceeded = true;
          },
        },
      ],
    });
    const result = await catalog.refresh();
    strictEqual(result.errors.get("错误"), error);
    strictEqual(result.errors.get("字符串")?.message, "字符串错误");
    strictEqual(result.errors.size, 2);
    strictEqual(hasSucceeded, true);
  });

  it("存储读取失败和发布更新失败计入来源错误", async (): Promise<void> => {
    const error = new Error("存储读取失败");
    const store: ModelsStore = {
      async read(): Promise<undefined> {
        throw error;
      },
      async write(): Promise<void> {},
      async delete(): Promise<void> {},
    };
    const source: ModelCatalogSource = {
      id: "读取",
      getModels(): readonly Model[] {
        return [];
      },
      async refreshModels(): Promise<void> {},
    };
    const catalog = new ModelCatalog({ modelsStore: store, sources: [source] });
    const readResult = await catalog.refresh();
    strictEqual(readResult.errors.get("读取"), error);
    const updateError = new Error("发布失败");
    const updateCatalog = new ModelCatalog({
      sources: [
        {
          id: "发布",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(context: ModelCatalogRefreshContext): Promise<void> {
            await context.publish({
              /** 验证发布回调错误可汇总。 */
              update: (): void => {
                throw updateError;
              },
            });
          },
        },
      ],
    });
    const updateResult = await updateCatalog.refresh();
    strictEqual(updateResult.errors.get("发布"), updateError);
  });

  it("已中断的调用立即返回，刷新中断停止等待且不记录来源错误", async (): Promise<void> => {
    const controller = new AbortController();
    controller.abort();
    const empty = new ModelCatalog();
    strictEqual((await empty.refresh({ signal: controller.signal })).aborted, true);
    const started = Promise.withResolvers<ModelCatalogRefreshContext>();
    const release = Promise.withResolvers<void>();
    const running = new ModelCatalog({
      sources: [
        {
          id: "来源",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(context: ModelCatalogRefreshContext): Promise<void> {
            started.resolve(context);
            await release.promise;
          },
        },
      ],
    });
    const activeController = new AbortController();
    const pending = running.refresh({ signal: activeController.signal });
    const context = await started.promise;
    activeController.abort();
    const result = await pending;
    strictEqual(result.aborted, true);
    strictEqual(result.errors.size, 0);
    strictEqual(context.signal.aborted, true);
    await rejects(context.publish({ persist: { models: [] } }), { name: "AbortError" });
    release.resolve();
  });

  it("刷新完成后旧代际发布被丢弃，替换来源保留新模型", async (): Promise<void> => {
    let previous: ModelCatalogRefreshContext | undefined;
    let hasUpdated = false;
    const store = new InMemoryModelsStore();
    const catalog = new ModelCatalog({
      modelsStore: store,
      sources: [
        {
          id: "来源",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(context: ModelCatalogRefreshContext): Promise<void> {
            previous = context;
          },
        },
      ],
    });
    await catalog.refresh();
    catalog.setSource({
      id: "来源",
      getModels(): readonly Model[] {
        return [model({ id: "新模型" })];
      },
    });
    ok(previous);
    const accepted = await previous.publish({
      persist: { models: [model({ id: "过期模型" })] },
      /** 检测过期发布是否调用更新。 */
      update: (): void => {
        hasUpdated = true;
      },
    });
    strictEqual(accepted, false);
    strictEqual(hasUpdated, false);
    strictEqual(await store.read("来源"), undefined);
    strictEqual(catalog.getModels()[0]?.id, "新模型");
  });

  for (const action of ["替换", "删除", "新刷新"] as const) {
    it(`${action}中断正在进行的旧刷新并丢弃旧发布`, async (): Promise<void> => {
      const started = Promise.withResolvers<ModelCatalogRefreshContext>();
      const release = Promise.withResolvers<void>();
      let invocationCount = 0;
      const catalog = new ModelCatalog({
        sources: [
          {
            id: "来源",
            getModels(): readonly Model[] {
              return [];
            },
            async refreshModels(context: ModelCatalogRefreshContext): Promise<void> {
              invocationCount++;
              if (invocationCount === 1) {
                started.resolve(context);
                await release.promise;
              }
            },
          },
        ],
      });
      const first = catalog.refresh();
      const context = await started.promise;
      if (action === "替换") {
        catalog.setSource({
          id: "来源",
          getModels(): readonly Model[] {
            return [];
          },
        });
      } else if (action === "删除") {
        catalog.deleteSource("来源");
      } else {
        await catalog.refresh();
      }
      const result = await first;
      strictEqual(context.signal.aborted, true);
      strictEqual(result.errors.size, 0);
      await rejects(context.publish({ persist: { models: [] } }), { name: "AbortError" });
      release.resolve();
    });
  }
});

describe("ModelCatalog 发布竞争", (): void => {
  it("写入未完成时替换来源，中断旧发布并阻止 update 回调", async (): Promise<void> => {
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hasUpdated = false;
    const store: ModelsStore = {
      async read(): Promise<undefined> {
        return undefined;
      },
      async write(): Promise<void> {
        writing.resolve();
        await release.promise;
      },
      async delete(): Promise<void> {},
    };
    const catalog = new ModelCatalog({
      modelsStore: store,
      sources: [
        {
          id: "来源",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(context: ModelCatalogRefreshContext): Promise<void> {
            await context.publish({
              persist: { models: [] },
              /** 检查过期持久化后不会执行模型更新。 */
              update: (): void => {
                hasUpdated = true;
              },
            });
          },
        },
      ],
    });
    const pending = catalog.refresh();
    await writing.promise;
    catalog.deleteSource("来源");
    const result = await pending;
    release.resolve();
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    strictEqual(result.errors.size, 0);
    strictEqual(hasUpdated, false);
  });

  it("同一来源并行发布保持顺序，前次失败不会阻止后次发布", async (): Promise<void> => {
    const order: string[] = [];
    const catalog = new ModelCatalog({
      sources: [
        {
          id: "来源",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(context: ModelCatalogRefreshContext): Promise<void> {
            const first = context.publish({
              /** 制造首个更新失败以验证发布队列恢复。 */
              update: (): void => {
                order.push("首次");
                throw new Error("首次失败");
              },
            });
            const second = context.publish({
              /** 记录失败后仍执行的更新。 */
              update: (): void => {
                order.push("后次");
              },
            });
            await rejects(first, /首次失败/);
            strictEqual(await second, true);
          },
        },
      ],
    });
    const result = await catalog.refresh();
    strictEqual(result.errors.size, 0);
    deepStrictEqual(order, ["首次", "后次"]);
  });
});

describe("ModelCatalog 刷新启动错误", (): void => {
  it("来源 ID 在注册后读取失败时 refresh 拒绝原错误", async (): Promise<void> => {
    const error = new Error("来源 ID 在刷新时无法读取");
    let shouldThrow = false;
    const source: ModelCatalogSource = {
      get id(): string {
        if (shouldThrow) {
          throw error;
        }
        return "来源";
      },
      getModels(): readonly Model[] {
        return [];
      },
      async refreshModels(): Promise<void> {},
    };
    const catalog = new ModelCatalog({ sources: [source] });
    shouldThrow = true;
    await rejects(catalog.refresh(), error);
  });
});

describe("ModelCatalog 空中断原因与延迟拒绝", (): void => {
  it("abort(null) 终止刷新，后续发布返回默认中断错误", async (): Promise<void> => {
    const started = Promise.withResolvers<ModelCatalogRefreshContext>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const catalog = new ModelCatalog({
      sources: [
        {
          id: "来源",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(context: ModelCatalogRefreshContext): Promise<void> {
            started.resolve(context);
            await release.promise;
          },
        },
      ],
    });
    const pending = catalog.refresh({ signal: controller.signal });
    const context = await started.promise;
    controller.abort(null);
    const result = await pending;
    strictEqual(result.aborted, true);
    strictEqual(result.errors.size, 0);
    strictEqual(context.signal.reason, null);
    await rejects(context.publish({ persist: { models: [] } }), /The operation was aborted/);
    release.resolve();
  });

  it("读取时同步中断后底层 Promise 延迟拒绝，不产生未处理拒绝", async (): Promise<void> => {
    const controller = new AbortController();
    const readResult = Promise.withResolvers<undefined>();
    let hasRefreshed = false;
    const store: ModelsStore = {
      read(): Promise<undefined> {
        controller.abort(null);
        return readResult.promise;
      },
      async write(): Promise<void> {},
      async delete(): Promise<void> {},
    };
    const catalog = new ModelCatalog({
      modelsStore: store,
      sources: [
        {
          id: "来源",
          getModels(): readonly Model[] {
            return [];
          },
          async refreshModels(): Promise<void> {
            hasRefreshed = true;
          },
        },
      ],
    });
    const result = await catalog.refresh({ signal: controller.signal });
    strictEqual(result.aborted, true);
    strictEqual(result.errors.size, 0);
    readResult.reject(new Error("中断后的底层读取失败"));
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    strictEqual(hasRefreshed, false);
    strictEqual(result.errors.size, 0);
  });
});

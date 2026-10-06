import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { InMemoryModelsStore, type ModelsStoreEntry } from "../../src/ai/models-store.ts";
import { model } from "./helpers.ts";

describe("InMemoryModelsStore", (): void => {
  it("空存储读取缺失来源返回 undefined，重复删除缺失来源不报错", async (): Promise<void> => {
    const store = new InMemoryModelsStore();
    strictEqual(await store.read("缺失"), undefined);
    await store.delete("缺失");
    await store.delete("缺失");
    strictEqual(await store.read("缺失"), undefined);
  });

  it("写入深拷贝条目及嵌套模型，后续修改输入不改变存储", async (): Promise<void> => {
    const store = new InMemoryModelsStore();
    const entry: ModelsStoreEntry = {
      models: [model({ headers: { "x-test": "原值" } })],
      checkedAt: 1,
      etag: "版本一",
    };
    await store.write("来源", entry);
    entry.checkedAt = 2;
    entry.models[0]!.headers!["x-test"] = "修改值";
    const stored = await store.read("来源");
    strictEqual(stored?.checkedAt, 1);
    strictEqual(stored?.etag, "版本一");
    deepStrictEqual(stored?.models[0]?.headers, { "x-test": "原值" });
  });

  it("读取返回独立深拷贝，修改读取结果不影响后续读取", async (): Promise<void> => {
    const store = new InMemoryModelsStore();
    await store.write("来源", { models: [model({ input: ["text", "image"] })] });
    const first = await store.read("来源");
    first!.models[0]!.input!.pop();
    first!.etag = "读取后修改";
    const second = await store.read("来源");
    deepStrictEqual(second?.models[0]?.input, ["text", "image"]);
    strictEqual(second?.etag, undefined);
  });

  it("同名写入覆盖条目，大小写不同及空字符串来源独立保存", async (): Promise<void> => {
    const store = new InMemoryModelsStore();
    await store.write("A", { models: [model({ id: "旧模型" })] });
    await store.write("a", { models: [model({ id: "另一模型" })] });
    await store.write("", { models: [] });
    await store.write("A", { models: [], lastModified: 2 });
    deepStrictEqual(await store.read("A"), { models: [], lastModified: 2 });
    strictEqual((await store.read("a"))?.models[0]?.id, "另一模型");
    deepStrictEqual(await store.read(""), { models: [] });
    await store.delete("A");
    strictEqual(await store.read("A"), undefined);
    strictEqual((await store.read("a"))?.models[0]?.id, "另一模型");
  });

  it("读写删除在信号已中断时拒绝并保留原条目", async (): Promise<void> => {
    const store = new InMemoryModelsStore();
    await store.write("来源", { models: [model()] });
    const controller = new AbortController();
    const error = new Error("测试中断");
    controller.abort(error);
    const options = { signal: controller.signal };
    await rejects(store.read("来源", options), error);
    await rejects(store.write("来源", { models: [] }, options), error);
    await rejects(store.delete("来源", options), error);
    strictEqual((await store.read("来源"))?.models.length, 1);
  });

  it("无法深拷贝的写入拒绝，不覆盖已经保存的条目", async (): Promise<void> => {
    const store = new InMemoryModelsStore();
    await store.write("来源", { models: [model()] });
    const invalidEntry = {
      models: [],
      /** 提供无法序列化的函数以验证写入失败。 */
      extra: (): void => {},
    };
    await rejects(store.write("来源", invalidEntry), { name: "DataCloneError" });
    strictEqual((await store.read("来源"))?.models.length, 1);
  });
});

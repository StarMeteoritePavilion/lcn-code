import type { Model } from "./types.ts";

export interface ModelsStoreEntry {
  models: readonly Model[];
  lastModified?: number;
  checkedAt?: number;
  etag?: string;
}

export interface ModelsStoreOperationOptions {
  signal?: AbortSignal;
}

export interface ModelsStore {
  read(
    sourceId: string,
    options?: ModelsStoreOperationOptions,
  ): Promise<ModelsStoreEntry | undefined>;
  write(
    sourceId: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ): Promise<void>;
  delete(sourceId: string, options?: ModelsStoreOperationOptions): Promise<void>;
}

/**
 * 基于内存 Map 的模型存储实现，读写时深拷贝条目以隔离调用方修改。
 */
export class InMemoryModelsStore implements ModelsStore {
  private readonly entries = new Map<string, ModelsStoreEntry>();

  /**
   * 读取来源对应的模型条目。
   * @param sourceId - 来源 id。
   * @param options - 可选操作选项，可携带中断信号。
   * @returns 条目的深拷贝；不存在时为 undefined。
   * @throws 信号已中断时以中断原因拒绝。
   */
  async read(
    sourceId: string,
    options?: ModelsStoreOperationOptions,
  ): Promise<ModelsStoreEntry | undefined> {
    options?.signal?.throwIfAborted();
    const entry = this.entries.get(sourceId);
    return entry ? structuredClone(entry) : undefined;
  }

  /**
   * 写入或覆盖来源对应的模型条目。
   * @param sourceId - 来源 id。
   * @param entry - 要保存的条目，保存的是其深拷贝。
   * @param options - 可选操作选项，可携带中断信号。
   * @returns 条目保存后兑现。
   * @throws 信号已中断时以中断原因拒绝。
   */
  async write(
    sourceId: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    this.entries.set(sourceId, structuredClone(entry));
  }

  /**
   * 删除来源对应的模型条目。
   * @param sourceId - 来源 id；不存在时不做任何操作。
   * @param options - 可选操作选项，可携带中断信号。
   * @returns 条目删除后兑现。
   * @throws 信号已中断时以中断原因拒绝。
   */
  async delete(sourceId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    this.entries.delete(sourceId);
  }
}

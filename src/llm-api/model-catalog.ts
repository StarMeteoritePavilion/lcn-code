import { InMemoryModelsStore, type ModelsStore, type ModelsStoreEntry } from "./models-store.ts";
import type { Model } from "./types.ts";

export interface ModelCatalogPublication {
  persist?: ModelsStoreEntry | null;
  update?: () => void;
}

export interface ModelCatalogRefreshContext {
  apiKey?: string;
  stored?: Readonly<ModelsStoreEntry>;
  publish(publication: ModelCatalogPublication): Promise<boolean>;
  allowNetwork: boolean;
  force?: boolean;
  signal: AbortSignal;
}

export interface ModelCatalogSource {
  readonly id: string;
  getModels(): readonly Model[];
  refreshModels?(context: ModelCatalogRefreshContext): Promise<void>;
}

export interface ModelCatalogRefreshOptions {
  apiKey?: string;
  allowNetwork?: boolean;
  sources?: readonly string[];
  force?: boolean;
  signal?: AbortSignal;
}

export interface ModelCatalogRefreshResult {
  aborted: boolean;
  errors: ReadonlyMap<string, Error>;
}

export interface ModelCatalogOptions {
  modelsStore?: ModelsStore;
  sources?: readonly ModelCatalogSource[];
}

/**
 * 返回调用方提供的中断信号，未提供时创建一个永不触发的信号。
 * @param signal - 调用方传入的可选中断信号。
 * @returns 可直接用于后续操作的中断信号。
 */
function operationSignal(signal?: AbortSignal): AbortSignal {
  return signal ?? new AbortController().signal;
}

/**
 * 获取信号的中断原因，原因为空时生成默认的中断错误。
 * @param signal - 已中断的信号。
 * @returns 用于拒绝 Promise 的中断原因。
 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("The operation was aborted");
}

/**
 * 让异步操作与中断信号竞速，信号先触发时立即以中断原因拒绝。
 * @param operation - 需要等待的异步操作。
 * @param signal - 控制等待是否提前结束的中断信号。
 * @returns 操作先完成时返回其结果；信号先触发时以中断原因拒绝。
 * @remarks 中断只会停止等待，不会取消底层操作；信号已中断时会吞掉 operation 后续的拒绝，避免未处理的 Promise 拒绝。
 */
function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch((): void => {});
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>(
    (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void): void => {
      let isSettled = false;
      /** 移除本次等待注册的中断监听器。 */
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      /** 以中断原因结束尚未完成的等待，并清理监听器。 */
      const onAbort = (): void => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        cleanup();
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void operation.then(
        (value: T): void => {
          if (isSettled) {
            return;
          }
          isSettled = true;
          cleanup();
          resolve(value);
        },
        (error: unknown): void => {
          if (isSettled) {
            return;
          }
          isSettled = true;
          cleanup();
          reject(error);
        },
      );
    },
  );
}

/**
 * 管理多个模型来源，提供模型查询以及带代际控制的并发刷新。
 * @remarks 同一来源的新刷新、替换或删除会中断旧刷新，旧刷新发布的结果将被丢弃。
 */
export class ModelCatalog {
  private readonly sources = new Map<string, ModelCatalogSource>();
  private readonly modelsStore: ModelsStore;
  private readonly generations = new Map<string, number>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly publicationChains = new Map<string, Promise<unknown>>();

  /**
   * 创建模型目录并注册初始来源。
   * @param options - 可选的模型存储与初始来源；未提供存储时使用 InMemoryModelsStore。
   */
  constructor(options?: ModelCatalogOptions) {
    this.modelsStore = options?.modelsStore ?? new InMemoryModelsStore();
    for (const source of options?.sources ?? []) {
      this.setSource(source);
    }
  }

  /**
   * 注册或替换模型来源。
   * @param source - 要注册的模型来源，按 id 覆盖同名来源。
   * @remarks 会中断该来源正在进行的刷新，并使其未完成的发布失效。
   */
  setSource(source: ModelCatalogSource): void {
    this.supersedeRefresh(source.id);
    this.sources.set(source.id, source);
  }

  /**
   * 删除模型来源。
   * @param sourceId - 要删除的来源 id；不存在时不做任何操作。
   * @remarks 会中断该来源正在进行的刷新，但不会删除模型存储中已持久化的条目。
   */
  deleteSource(sourceId: string): void {
    this.supersedeRefresh(sourceId);
    this.sources.delete(sourceId);
  }

  /**
   * 获取当前注册的全部模型来源。
   * @returns 按注册顺序排列的来源数组副本。
   */
  getSources(): readonly ModelCatalogSource[] {
    return [...this.sources.values()];
  }

  /**
   * 获取指定来源或全部来源的模型列表。
   * @param sourceId - 可选的来源 id；省略时汇总全部来源。
   * @returns 模型数组；来源不存在或其 getModels 抛出异常时，该来源贡献空列表。
   */
  getModels(sourceId?: string): readonly Model[] {
    const sources =
      sourceId === undefined ? this.getSources() : [this.sources.get(sourceId)].filter(Boolean);
    return sources.flatMap((source: ModelCatalogSource | undefined): readonly Model[] => {
      try {
        return source!.getModels();
      } catch {
        return [];
      }
    });
  }

  /**
   * 在指定来源中按模型 id 查找模型。
   * @param sourceId - 来源 id。
   * @param modelId - 模型 id。
   * @returns 匹配的模型；来源或模型不存在时返回 undefined。
   */
  getModel(sourceId: string, modelId: string): Model | undefined {
    return this.getModels(sourceId).find((model: Model): boolean => model.id === modelId);
  }

  /**
   * 推进来源的刷新代际并中断其正在进行的刷新。
   * @param sourceId - 来源 id。
   * @returns 新的代际编号，旧代际的发布将被拒绝。
   */
  private supersedeRefresh(sourceId: string): number {
    const generation = (this.generations.get(sourceId) ?? 0) + 1;
    this.generations.set(sourceId, generation);
    const previous = this.controllers.get(sourceId);
    if (previous) {
      this.controllers.delete(sourceId);
      previous.abort();
    }
    return generation;
  }

  /**
   * 为来源开启新一轮刷新，并登记对应的中断控制器。
   * @param sourceId - 来源 id。
   * @returns 本轮刷新的代际编号与中断控制器。
   */
  private beginRefresh(sourceId: string): { generation: number; controller: AbortController } {
    const generation = this.supersedeRefresh(sourceId);
    const controller = new AbortController();
    this.controllers.set(sourceId, controller);
    return { generation, controller };
  }

  /**
   * 按来源串行执行发布：持久化模型条目后调用 update 回调。
   * @param sourceId - 来源 id。
   * @param generation - 发起发布的刷新代际。
   * @param signal - 本轮刷新的中断信号。
   * @param publication - 发布内容；persist 为 null 时删除存储条目，为 undefined 时不改动存储。
   * @returns 发布生效时为 true；发布前刷新代际已过期且信号未中断时为 false。
   * @throws 信号已中断或在发布完成前中断时以中断原因拒绝；模型存储读写或 update 回调失败时透传其错误。
   */
  private publish(
    sourceId: string,
    generation: number,
    signal: AbortSignal,
    publication: ModelCatalogPublication,
  ): Promise<boolean> {
    const previous = this.publicationChains.get(sourceId) ?? Promise.resolve();
    const queued = (async (): Promise<boolean> => {
      await previous.catch((): void => {});
      if (signal.aborted || this.generations.get(sourceId) !== generation) {
        return false;
      }

      if (publication.persist === null) {
        await this.modelsStore.delete(sourceId, { signal });
      } else if (publication.persist !== undefined) {
        await this.modelsStore.write(sourceId, structuredClone(publication.persist), { signal });
      }

      if (signal.aborted || this.generations.get(sourceId) !== generation) {
        return false;
      }
      publication.update?.();
      return true;
    })();
    const tail = queued.catch((): void => {});
    this.publicationChains.set(sourceId, tail);
    void tail.then((): void => {
      if (this.publicationChains.get(sourceId) === tail) {
        this.publicationChains.delete(sourceId);
      }
    });
    return raceWithAbortSignal(queued, signal);
  }

  /**
   * 读取来源的已存储条目并调用其 refreshModels 执行一次刷新。
   * @param source - 支持刷新的模型来源。
   * @param apiKey - 传给来源的 API 密钥。
   * @param isNetworkAllowed - 本次刷新是否允许访问网络。
   * @param shouldForce - 是否强制刷新；仅在允许网络时传给来源。
   * @param generation - 本轮刷新的代际编号。
   * @param signal - 本轮刷新的中断信号。
   * @returns 来源的 refreshModels 完成后兑现。
   */
  private async refreshSource(
    source: ModelCatalogSource & Required<Pick<ModelCatalogSource, "refreshModels">>,
    apiKey: string | undefined,
    isNetworkAllowed: boolean,
    shouldForce: boolean | undefined,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const stored = await this.modelsStore.read(source.id, { signal });
    await source.refreshModels({
      apiKey,
      stored,
      /**
       * 在当前刷新代际中发布模型更新。
       * @param publication - 待持久化或发送的更新。
       * @returns 更新成功发布时为 true；刷新代际已失效且信号未中断时为 false。
       * @throws 信号已中断或发布期间中断、持久化或更新回调失败时拒绝。
       */
      publish: (publication: ModelCatalogPublication): Promise<boolean> =>
        this.publish(source.id, generation, signal, publication),
      allowNetwork: isNetworkAllowed,
      force: isNetworkAllowed ? shouldForce : undefined,
      signal,
    });
  }

  /**
   * 并发刷新可刷新的模型来源：先执行离线刷新，再在允许网络且提供 apiKey 时执行联网刷新。
   * @param options - 刷新选项；allowNetwork 默认为 true，sources 省略时刷新全部可刷新来源。
   * @returns 全部来源结束或调用方信号中断后兑现，包含是否被中断以及各来源的错误。
   * @remarks 单个来源的失败记录在 errors 中而不会拒绝；被中断或被新刷新取代的来源不记录错误。
   */
  async refresh(options: ModelCatalogRefreshOptions = {}): Promise<ModelCatalogRefreshResult> {
    const isNetworkAllowed = options.allowNetwork ?? true;
    const callerSignal = operationSignal(options.signal);
    const errors = new Map<string, Error>();
    if (callerSignal.aborted) {
      return { aborted: true, errors };
    }
    const selected = options.sources ? new Set(options.sources) : undefined;
    const refreshable = this.getSources().filter(
      (
        source: ModelCatalogSource,
      ): source is ModelCatalogSource & Required<Pick<ModelCatalogSource, "refreshModels">> =>
        source.refreshModels !== undefined && (!selected || selected.has(source.id)),
    );

    const refresh = Promise.all(
      refreshable.map(
        async (
          source: ModelCatalogSource & Required<Pick<ModelCatalogSource, "refreshModels">>,
        ): Promise<void> => {
          const { generation, controller } = this.beginRefresh(source.id);
          const signal = AbortSignal.any([callerSignal, controller.signal]);
          try {
            await raceWithAbortSignal(
              this.refreshSource(source, options.apiKey, false, undefined, generation, signal),
              signal,
            );
            if (!isNetworkAllowed || signal.aborted || !options.apiKey) {
              return;
            }
            await raceWithAbortSignal(
              this.refreshSource(source, options.apiKey, true, options.force, generation, signal),
              signal,
            );
          } catch (error) {
            if (!signal.aborted) {
              const normalizedError = error instanceof Error ? error : new Error(String(error));
              errors.set(source.id, normalizedError);
            }
          } finally {
            if (this.controllers.get(source.id) === controller) {
              this.controllers.delete(source.id);
            }
          }
        },
      ),
    );

    try {
      await raceWithAbortSignal(refresh, callerSignal);
    } catch (error) {
      if (!callerSignal.aborted) {
        throw error;
      }
    }
    return { aborted: callerSignal.aborted, errors: new Map(errors) };
  }
}

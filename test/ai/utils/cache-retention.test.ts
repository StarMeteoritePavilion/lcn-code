import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { resolveCacheRetention } from "../../../src/ai/utils/cache-retention.ts";

/**
 * 临时设置缓存环境并在检查结束后恢复。
 * @param value - 检查使用的环境值。
 * @param check - 独立的检查回调。
 */
function withRetention(value: string, check: () => void): void {
  const previous = process.env.PI_CACHE_RETENTION;
  process.env.PI_CACHE_RETENTION = value;
  try {
    check();
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CACHE_RETENTION;
    } else {
      process.env.PI_CACHE_RETENTION = previous;
    }
  }
}

describe("resolveCacheRetention", (): void => {
  it("显式策略优先于环境", (): void => {
    strictEqual(resolveCacheRetention("none", { PI_CACHE_RETENTION: "long" }), "none");
    strictEqual(resolveCacheRetention("short", { PI_CACHE_RETENTION: "long" }), "short");
  });
  it("请求环境与进程环境的long均生效", (): void => {
    withRetention("long", (): void => {
      strictEqual(resolveCacheRetention(undefined, {}), "long");
      strictEqual(resolveCacheRetention(undefined, { PI_CACHE_RETENTION: "long" }), "long");
    });
  });
  it("未知环境值回退short而非猜测名称或大小写", (): void => {
    withRetention("LONG", (): void => {
      strictEqual(resolveCacheRetention(undefined, { PI_CACHE_RETENTION: "LONG" }), "short");
    });
  });
});

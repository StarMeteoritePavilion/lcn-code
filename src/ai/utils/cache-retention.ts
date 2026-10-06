import type { CacheRetention, RequestEnv } from "../types.ts";

/**
 * 解析请求使用的提示缓存保留策略。
 * @param cacheRetention - 调用方显式指定的保留策略。
 * @param env - 可选的请求级环境变量。
 * @returns 显式指定时直接返回；否则 `env.PI_CACHE_RETENTION` 或 `process.env.PI_CACHE_RETENTION` 为 `"long"` 时返回 `"long"`，其余情况返回 `"short"`。
 * @remarks 在存在 `process` 的运行时会读取 `process.env`。
 */
export function resolveCacheRetention(
  cacheRetention?: CacheRetention,
  env?: RequestEnv,
): CacheRetention {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (env?.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

interface RequestRetryOptions {
  maxRetries?: number;
  maxRetryDelayMs?: number;
  signal?: AbortSignal;
}

interface RequestError extends Error {
  status: number | undefined;
  headers: Headers | undefined;
}

/**
 * 判断错误是否为带有 `status` 与 `headers` 字段的 SDK 请求错误。
 * @param error - 捕获到的任意错误值。
 * @returns `status` 为数字或 undefined、`headers` 为 `Headers` 或 undefined 的 `Error` 返回 true，否则返回 false。
 */
function isRequestError(error: unknown): error is RequestError {
  if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) {
    return false;
  }
  return (
    (error.status === undefined || typeof error.status === "number") &&
    (error.headers === undefined || error.headers instanceof Headers)
  );
}

/**
 * 判断请求错误是否可重试，与当前锁定版本的 OpenAI/Anthropic SDK 重试策略保持一致。
 * @param error - SDK 请求错误。
 * @returns 可重试时返回 true，否则返回 false。
 * @remarks 优先遵循 `x-should-retry` 响应头；否则无状态码（连接错误）以及 408、409、429、5xx 视为可重试。任一 SDK 升级时需复核。
 */
function isRetryableRequestError(error: RequestError): boolean {
  const shouldRetry = error.headers?.get("x-should-retry");
  if (shouldRetry === "true") {
    return true;
  }
  if (shouldRetry === "false") {
    return false;
  }

  if (error.status === undefined) {
    return true;
  }
  return (
    error.status === 408 ||
    error.status === 409 ||
    error.status === 429 ||
    (typeof error.status === "number" && error.status >= 500)
  );
}

/**
 * 校验服务端要求的重试延迟不超过允许的上限。
 * @param delayMs - 服务端要求的延迟毫秒数。
 * @param maxRetryDelayMs - 允许的最大延迟毫秒数；未提供时使用 60 秒，小于等于 0 表示不限制。
 * @param requestErrorMessage - 原始请求错误消息，附加在抛出的错误消息末尾。
 * @returns 校验通过时原样返回 `delayMs`。
 * @throws 延迟超过上限时抛出 `Error`。
 */
function validateServerRetryDelayMs(
  delayMs: number,
  maxRetryDelayMs: number | undefined,
  requestErrorMessage: string,
): number {
  const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (maxDelayMs > 0 && delayMs > maxDelayMs) {
    throw new Error(
      `Server requested ${Math.ceil(delayMs / 1000)}s retry delay ` +
        `(max: ${Math.ceil(maxDelayMs / 1000)}s). ${requestErrorMessage}`,
    );
  }
  return delayMs;
}

/**
 * 计算下一次重试前的等待毫秒数。
 * @param error - SDK 请求错误。
 * @param retryIndex - 从 0 开始的重试序号。
 * @param maxRetryDelayMs - 服务端要求延迟的上限毫秒数，语义同 `validateServerRetryDelayMs`。
 * @returns 等待毫秒数：优先使用 `retry-after-ms`，其次 `retry-after`（秒数或 HTTP 日期）；均不可用时使用 0.5 秒起、上限 8 秒的指数退避，并减去最多 25% 的随机抖动。
 * @throws 服务端要求的延迟超过上限时抛出 `Error`。
 */
function getRetryDelayMs(
  error: RequestError,
  retryIndex: number,
  maxRetryDelayMs: number | undefined,
): number {
  const retryAfterMs = error.headers?.get("retry-after-ms");
  if (retryAfterMs) {
    const value = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(value)) {
      return validateServerRetryDelayMs(value, maxRetryDelayMs, error.message);
    }
  }

  const retryAfter = error.headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
    if (Number.isFinite(delayMs)) {
      return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error.message);
    }
  }

  const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
  return exponentialDelay * (1 - Math.random() * 0.25);
}

function createAbortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

/**
 * 等待指定毫秒数，可被 `AbortSignal` 中断。
 * @param ms - 等待毫秒数，负数按 0 处理。
 * @param signal - 可选的中断信号。
 * @returns 等待结束时完成的 Promise。
 * @throws 信号已中断或等待期间被中断时，以名为 `AbortError` 的错误拒绝。
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(
    (
      resolve: (value: void | PromiseLike<void>) => void,
      reject: (reason?: unknown) => void,
    ): void => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }

      /** 清理等待定时器，并以中断异常拒绝当前等待。 */
      const onAbort = (): void => {
        clearTimeout(timeout);
        reject(createAbortError());
      };
      const timeout = setTimeout(
        (): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
    },
  );
}

/**
 * 复现 OpenAI 与 Anthropic SDK 的重试行为，并使退避等待可被中断。
 * @param request - 发起一次请求的函数，每次重试都会重新调用。
 * @param options - 重试选项：`maxRetries` 最大重试次数（默认 0），`maxRetryDelayMs` 服务端要求延迟的上限（默认 60 秒，设为 0 取消限制），`signal` 中断信号。
 * @returns 请求最终成功时以其结果完成的 Promise。
 * @throws 信号已中断时抛出名为 `AbortError` 的错误；错误不可重试或重试次数耗尽时抛出最后一次的原始错误；服务端要求的延迟超过上限时抛出 `Error`。
 * @remarks SDK 内置的重试计时器会忽略请求的 AbortSignal，因此调用方需以 `maxRetries: 0` 调用 SDK，并用本函数包装请求。
 */
export async function retryRequest<T>(
  request: () => Promise<T>,
  options: RequestRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 0;
  let retriesRemaining = maxRetries;

  for (;;) {
    try {
      // 每次重试都会重新发起 SDK 请求，因此 X-Stainless-Retry-Count 始终为 0。
      return await request();
    } catch (error) {
      if (options.signal?.aborted) {
        throw createAbortError();
      }
      if (retriesRemaining <= 0 || !isRequestError(error) || !isRetryableRequestError(error)) {
        throw error;
      }

      const retryIndex = maxRetries - retriesRemaining;
      retriesRemaining--;
      await abortableSleep(
        getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs),
        options.signal,
      );
    }
  }
}

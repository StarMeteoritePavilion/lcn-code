import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
  // OpenCode Zen API 通过 HTTP 429 的 JSON 错误类型返回 Go 或免费套餐限制。这些属于订阅或账户上限，不是临时限流。
  "GoUsageLimitError",
  "FreeUsageLimitError",

  // OpenCode Go 的滚动、周或月订阅上限触发后，错误文本会提示启用可用余额计费。
  "Monthly usage limit reached",
  "available balance",

  // 通用配额、预算或余额耗尽。insufficient_quota 是 OpenAI 的配额或计费错误码，其他字符串覆盖常见网关文本。
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "billing",

  // 使用 ChatGPT 登录时的订阅共享用量上限，恢复通常需要数小时而非数秒。
  "subscription_sharing_usage_limit_exceeded",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  // 提供商负载、HTTP 状态与服务端临时故障的通用模式。
  "overloaded",
  "currently experiencing high demand",
  "model is at capacity",
  "rate.?limit",
  "too many requests",
  "429",
  "500",
  "502",
  "503",
  "504",
  "520",
  "524",
  "service.?unavailable",
  "server.?error",
  "internal.?error",

  // 上游临时故障的包装或提供商文本，包括 OpenRouter 的 Provider returned error 响应（#2264）。
  "provider.?returned.?error",
  "exceeded request buffer limit while retrying upstream",

  // 网络、代理与 fetch 传输故障，包括 OpenAI Codex 原生 fetch 的 upstream connect、connection refused、reset before headers（#733），以及 OpenRouter 连接中断（#3317）。
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?lost",
  "other side closed",
  "fetch failed",
  "getaddrinfo",
  "ENOTFOUND",
  "EAI_AGAIN",
  "upstream.?connect",
  "reset before headers",
  "socket hang up",
  "socket connection was closed",
  "timed? out",
  "timeout",
  "terminated",

  // WebSocket 传输可能返回连接关闭或错误文本，而不是 HTTP 或 fetch 文本。
  "websocket.?closed",
  "websocket.?error",

  // SDK 或传输提前结束流：Anthropic 可抛出 stream ended without ... 或 Anthropic stream ended before message_stop（#4433）；Bedrock/Smithy 可抛出 HTTP/2 无响应错误（#3594）。
  "ended without",
  "stream ended before message_stop",
  "stream ended before a terminal response event",
  "http2 request did not get a response",
  // Node 的 ERR_HTTP2_STREAM_CANCEL 表示请求发送前 HTTP/2 会话已结束，例如 Bedrock SDK 五分钟会话超时（#10379）。
  "pending stream has been canceled",

  // 提供商要求的重试延迟超过上限时，交由外层重试策略处理，让调用方展示或中断退避（#1123）。
  "retry delay",

  // OpenAI Responses 与 Bedrock 的流式异常中显式给出的重试提示（#6019）。
  "you can retry your request",
  "try your request again",
  "please retry your request",

  // 使用 gRPC 的提供商，例如 NVIDIA NIM。
  "ResourceExhausted",

  // 使用 ChatGPT 登录时，用量或用户数据暂时不可用；用量查询故障也可能在流中出现且没有 HTTP 503 文本。
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
]);

/**
 * 次数受限、指数退避的重试策略：延迟为 baseDelayMs * 2^(attempt-1)，maxAgentDelayMs 限制每次延迟，默认 60 秒。字段与 coding-agent 的 settings.retry（enabled、maxRetries、baseDelayMs、maxAgentDelayMs）一致；将分类器与策略重试循环放在一起，供 SDK 与其他调用方复用。
 */
export interface RetryPolicy {
  enabled: boolean;
  /**
   * 最多重试次数，0 表示不重试；首次调用不计入重试。
   */
  maxRetries: number;
  /**
   * 基础延迟，单位毫秒；加入随机扰动前，每轮延迟为 baseDelayMs * 2^(attempt-1)。
   */
  baseDelayMs: number;
  /**
   * 代理级重试延迟上限，单位毫秒，默认 60 秒。
   */
  maxAgentDelayMs?: number;
}

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

/**
 * 按指数退避计算第 `attempt` 次重试前的等待时长。
 *
 * @param policy - 提供 `baseDelayMs` 与可选 `maxAgentDelayMs` 的重试策略。
 * @param attempt - 重试序号（从 1 开始）；小于 1 时按 1 处理。
 * @returns 等待毫秒数，即 `baseDelayMs * 2^(attempt-1)`，超出安全整数时取 `Number.MAX_SAFE_INTEGER`，并以 `maxAgentDelayMs`（默认 {@link DEFAULT_MAX_AGENT_RETRY_DELAY_MS}）为上限。
 * @remarks 不添加随机抖动。
 */
export function retryDelayMs(
  policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">,
  attempt: number,
): number {
  const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
  return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}

/**
 * 由 {@link retryAssistantCall} 在重试前后调用的可选回调。
 */
export interface RetryCallbacks {
  /**
   * 每次重试退避等待前调用，轮次从 1 开始。
   */
  onRetryScheduled?: (
    attempt: number,
    maxAttempts: number,
    delayMs: number,
    errorMessage: string,
  ) => void | Promise<void>;
  /**
   * 退避等待结束、重试调用开始前调用。
   */
  onRetryAttemptStart?: () => void | Promise<void>;
  /**
   * 循环结束时调用一次；后续调用正常完成时标记成功。
   */
  onRetryFinished?: (
    success: boolean,
    attempt: number,
    finalError?: string,
  ) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
  constructor() {
    super("Aborted");
  }
}

/**
 * 等待指定时长，可被中止信号提前打断。
 *
 * @param ms - 等待的毫秒数。
 * @param signal - 可选中止信号。
 * @returns 到时后完成的 Promise。
 * @throws RetrySleepAbortError 信号已中止或等待期间被中止时以该错误拒绝。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(
    (
      resolve: (value: void | PromiseLike<void>) => void,
      reject: (reason?: unknown) => void,
    ): void => {
      if (signal?.aborted) {
        reject(new RetrySleepAbortError());
        return;
      }
      const timeout = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        (): void => {
          clearTimeout(timeout);
          reject(new RetrySleepAbortError());
        },
        { once: true },
      );
    },
  );
}

/**
 * 执行一次产生助手消息的调用，并在遇到瞬时错误时进行有限次数的重试。
 *
 * @param produce - 产生助手消息的调用，每次尝试都会重新执行。
 * @param policy - 重试策略；为 `undefined` 或未启用时直接返回首次结果（等同于直接调用 `produce()`）。
 * @param signal - 可选中止信号，用于打断退避等待。
 * @param callbacks - 可选的重试过程回调。
 * @returns Promise 完成时返回最终的助手消息：成功响应、中止响应、不可重试或重试次数耗尽时的最后一次错误响应；退避等待期间被中止时，返回以最后一次错误响应为基础、去掉 `errorMessage` 且 `stopReason` 为 `"aborted"` 的消息。
 * @throws `produce` 或回调抛出的错误，以及等待期间出现的非中止错误会原样向上抛出。
 * @remarks
 * - 成功响应立即返回；中止是终止状态且从不重试，若发生在已安排重试之后则报告为失败。
 * - 不可重试的错误（依据 {@link isRetryableAssistantError}，包括额度/计费耗尽）立即返回，使确定性错误快速失败。
 * - 其他情况最多重试 `maxRetries` 次并按 {@link retryDelayMs} 指数退避：每次等待前触发 `onRetryScheduled`，等待结束、重试开始前触发 `onRetryAttemptStart`；只要发生过重试，循环结束时（成功、耗尽或退避被中止）触发一次 `onRetryFinished`。
 */
export async function retryAssistantCall(
  produce: () => Promise<AssistantMessage>,
  policy: RetryPolicy | undefined,
  signal: AbortSignal | undefined,
  callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
  const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

  let attempt = 0;
  let lastRetry: { attempt: number; errorMessage: string } | undefined;
  for (;;) {
    const response = await produce();

    // 中断是终止状态，但不是成功；不重试已中断消息。
    if (response.stopReason === "aborted") {
      if (lastRetry) {
        await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
      }
      return response;
    }

    // 非错误且非中断的响应作为成功结果原样返回。
    if (response.stopReason !== "error") {
      if (lastRetry) {
        await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
      }
      return response;
    }

    // 不可重试或次数耗尽时，返回最终错误消息。
    if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
      if (lastRetry) {
        await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
      }
      return response;
    }

    attempt++;
    lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
    const delayMs = retryDelayMs(policy!, attempt);
    await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

    // 将退避等待中的中断规范化为与提供商流中断相同的 AssistantMessage，使调用方无需区分取消时机。
    try {
      await sleep(delayMs, signal);
    } catch (error) {
      await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
      if (error instanceof RetrySleepAbortError) {
        const { errorMessage: _errorMessage, ...rest } = response;
        return { ...rest, stopReason: "aborted" };
      }
      throw error;
    }
    await callbacks?.onRetryAttemptStart?.();
  }
}

/**
 * 判断失败的助手消息是否属于提供方或传输层的瞬时错误，供调用方决定是否重启上一轮助手回复。
 *
 * @param message - 待判断的助手消息。
 * @returns `stopReason` 为 `"error"`、错误信息非空、不匹配额度/计费等不可重试模式且匹配瞬时错误模式时返回 `true`；否则返回 `false`。
 * @remarks 不实现重试策略。调用方应先单独处理上下文溢出，再自行应用重试预算、退避与上报逻辑。
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) {
    return false;
  }
  const errorMessage = message.errorMessage;
  if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) {
    return false;
  }
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

// 统一规范化提供商的 HTTP 错误对象。代理或网关返回非 2xx 响应时，SDK 可能无法将响应体合并到 error.message；原始或已解析响应体与状态码仍以 SDK 特定字段保留。仅读取 error.message 会丢失响应体，产生 403 status code (no body) 或 Unknown: UnknownError 等不透明错误。normalizeProviderError 读取 Mistral、openai、@google/genai 与 AWS Bedrock 等已知 SDK 字段结构，返回用于组装显示字符串的结构。Anthropic 或 @google/genai 已将响应体合入消息时，通过 hasMessageBody 标记避免重复显示。

const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError {
  /**
   * 从 SDK 错误对象中提取的 HTTP 状态码，无法提取时省略。
   */
  status?: number;
  /**
   * 原始 HTTP 响应体中的错误原因，已去除首尾空白并按上限截断。
   */
  body?: string;
  /**
   * Error 对象的 error.message；其他抛出值使用 safeJsonStringify(error)。
   */
  message: string;
  /**
   * message 已包含响应体或未提取到响应体时为 true，无需另外追加。
   */
  hasMessageBody: boolean;
}

type SdkErrorShape = Error & {
  statusCode?: unknown;
  status?: unknown;
  body?: unknown;
  error?: unknown;
  $metadata?: { httpStatusCode?: unknown };
  $response?: { statusCode?: unknown; body?: unknown };
};

/**
 * 将提供方 SDK 抛出的错误规范化为包含状态码、响应体和消息的结构。
 * @param error - 捕获到的任意错误值。
 * @returns 规范化后的错误信息；非 `Error` 值仅包含其 JSON 序列化结果作为 `message`，`hasMessageBody` 为 false。
 * @remarks 按 Mistral、`openai`、`@google/genai`、AWS Bedrock 的已知字段探测状态码与响应体；未提取到响应体或 `message` 已包含响应体时，`hasMessageBody` 为 true。
 */
export function normalizeProviderError(error: unknown): NormalizedProviderError {
  if (!(error instanceof Error)) {
    return { message: safeJsonStringify(error), hasMessageBody: false };
  }

  const sdkError = error as SdkErrorShape;
  const status = extractStatus(sdkError);
  const body = extractBody(sdkError);
  const hasMessageBody = body === undefined || error.message.includes(body);

  return {
    status,
    body,
    message: error.message,
    hasMessageBody,
  } satisfies NormalizedProviderError;
}

/**
 * 按 SDK 字段顺序探测 HTTP 状态码，取第一个数值型字段。
 * @param error - SDK 错误对象。
 * @returns HTTP 状态码；所有字段均非数值时返回 undefined。
 * @remarks 探测顺序：`statusCode`（Mistral）→ `status`（`openai`、`@google/genai`）→ `$metadata.httpStatusCode`（Bedrock）→ `$response.statusCode`（Bedrock）。
 */
function extractStatus(error: SdkErrorShape): number | undefined {
  if (typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if (typeof error.status === "number") {
    return error.status;
  }
  if (typeof error.$metadata?.httpStatusCode === "number") {
    return error.$metadata.httpStatusCode;
  }
  if (typeof error.$response?.statusCode === "number") {
    return error.$response.statusCode;
  }
  return undefined;
}

/**
 * 按 SDK 字段顺序探测原始响应体，取第一个可用值，并裁剪首尾空白、截断到上限。
 * @param error - SDK 错误对象。
 * @returns 截断到 `MAX_PROVIDER_ERROR_BODY_CHARS` 的响应体；无可用响应体或裁剪后为空时返回 undefined。
 * @remarks 探测顺序：`body` 字符串（Mistral）→ `error` 已解析 JSON 对象（`openai` SDK 的 `this.error`）→ `$response.body`（Bedrock）。空对象和未读取的响应流视为无响应体，避免输出 `"{}"` 或流的内部结构。
 */
function extractBody(error: SdkErrorShape): string | undefined {
  const bodyText = pickBodyText(error);
  if (bodyText === undefined) {
    return undefined;
  }
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

/**
 * 按 SDK 字段优先级选取未经裁剪的响应体文本。
 * @param error - SDK 错误对象。
 * @returns 第一个可用的响应体文本；字段为未读取的流、类实例或空对象时返回 undefined。
 */
function pickBodyText(error: SdkErrorShape): string | undefined {
  if (typeof error.body === "string") {
    return error.body;
  }
  if (isPlainNonEmptyObject(error.error)) {
    return safeJsonStringify(error.error);
  }
  const responseBody = error.$response?.body;
  if (typeof responseBody === "string") {
    return responseBody;
  }
  if (isReadableStreamLike(responseBody)) {
    return undefined;
  }
  if (isPlainNonEmptyObject(responseBody)) {
    return safeJsonStringify(responseBody);
  }
  return undefined;
}

/**
 * 判断值是否为带 `pipe` 方法的 Node.js 风格可读流。
 * @param value - 待判断的值。
 * @returns 是带 `pipe` 函数的对象时返回 true，否则返回 false。
 */
function isReadableStreamLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "pipe" in value &&
    typeof value.pipe === "function"
  );
}

/**
 * 判断值是否为非空的普通对象（原型为 `Object.prototype` 或 null）。
 * @param value - 待判断的值。
 * @returns 是至少含一个自有可枚举键的普通对象时返回 true，否则返回 false。
 * @remarks
 * 只有普通对象才被视为 HTTP 响应体。SDK 错误字段可能保存类实例而非已解析的响应体，例如 AWS SDK v3 的 `$response.body`
 * 是 HTTP 流/响应包装对象，序列化后会得到 `{"_events":...}` 之类的噪声并替换掉真正有用的 `error.message`。
 * 类实例不产生响应体，`hasMessageBody` 保持 true，从而保留真实消息。该检查与上方的 `pipe` 探测互补：
 * Web ReadableStream（只有 pipeTo/pipeThrough）及非流式 SDK 包装类无法通过原型检查，而已解析的 JSON 响应体仍可通过。
 */
function isPlainNonEmptyObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  return Object.keys(value).length > 0;
}

/**
 * 根据规范化错误组合用于展示的错误字符串。
 * @param norm - `normalizeProviderError` 返回的规范化错误。
 * @param prefix - 可选的提供方前缀。
 * @returns 展示用错误字符串。
 * @remarks
 * 当 `message` 已包含响应体，或未提取到状态码/响应体时，使用 `message`：有前缀且有状态码时为 `"<prefix> (<status>): <message>"`，否则原样返回 `message`。
 * 其余情况展示状态码与响应体：无前缀为 `"<status>: <body>"`，有前缀为 `"<prefix> (<status>): <body>"`。
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
  if (norm.hasMessageBody || norm.status === undefined || norm.body === undefined) {
    return prefix !== undefined && norm.status !== undefined
      ? `${prefix} (${norm.status}): ${norm.message}`
      : norm.message;
  }
  return prefix !== undefined
    ? `${prefix} (${norm.status}): ${norm.body}`
    : `${norm.status}: ${norm.body}`;
}

/**
 * 将错误文本截断到指定字符数，并附加被截断的字符数说明。
 * @param text - 原始错误文本。
 * @param maxChars - 保留的最大字符数（按 UTF-16 码元计）。
 * @returns 长度不超过上限时原样返回；否则返回前 `maxChars` 个字符加 `... [truncated N chars]` 后缀。
 */
function truncateErrorText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

/**
 * 安全地将任意值序列化为 JSON 字符串，不会抛出异常。
 * @param value - 待序列化的值。
 * @returns JSON 字符串；`JSON.stringify` 返回 undefined（如函数、undefined）或抛出异常（如循环引用）时退回 `String(value)`。
 */
function safeJsonStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

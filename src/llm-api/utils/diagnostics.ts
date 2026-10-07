import type { JsonObject } from "../types.ts";

export interface DiagnosticErrorInfo {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
}

export interface AssistantMessageDiagnostic {
  type: string;
  timestamp: number;
  error?: DiagnosticErrorInfo;
  details?: JsonObject;
}

/**
 * 将任意抛出值格式化为可读的错误消息。
 * @param value - 被抛出的任意值。
 * @returns `Error` 返回其 `message`（为空时退回 `name`）；字符串原样返回；其他值返回 `String(value)`。
 */
export function formatThrownValue(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

/**
 * 从任意抛出值中提取诊断用的错误信息。
 * @param error - 被抛出的任意值。
 * @returns 错误信息：`Error` 提取 `name`、`message`、`stack` 及字符串或数字类型的 `code`；非 `Error` 值的 `name` 固定为 `"ThrownValue"`。
 */
export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
  if (!(error instanceof Error)) {
    return { name: "ThrownValue", message: formatThrownValue(error) };
  }
  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name || undefined,
    message: error.message || error.name,
    stack: error.stack,
    code: typeof code === "string" || typeof code === "number" ? code : undefined,
  };
}

/**
 * 创建一条带当前时间戳的助手消息诊断记录。
 * @param type - 诊断类型标识。
 * @param error - 关联的抛出值，会经 `extractDiagnosticError` 提取信息。
 * @param details - 可选的附加 JSON 详情。
 * @returns 新的诊断记录，`timestamp` 为 `Date.now()` 毫秒时间戳。
 */
export function createAssistantMessageDiagnostic(
  type: string,
  error: unknown,
  details?: JsonObject,
): AssistantMessageDiagnostic {
  return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

/**
 * 将诊断记录追加到消息的 `diagnostics` 列表末尾。
 * @param message - 待追加诊断的消息对象。
 * @param diagnostic - 要追加的诊断记录。
 * @remarks 会就地修改 `message`，以新数组替换原 `diagnostics`，不修改原数组。
 */
export function appendAssistantMessageDiagnostic<
  T extends { diagnostics?: AssistantMessageDiagnostic[] },
>(message: T, diagnostic: AssistantMessageDiagnostic): void {
  message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}

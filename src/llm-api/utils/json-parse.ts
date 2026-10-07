import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

/**
 * 将控制字符转换为 JSON 转义序列。
 *
 * @param char - 单个控制字符。
 * @returns 常见控制字符返回两字符短转义（如 `\n`），其余返回 `\u00XX` 形式的六字符转义。
 */
function escapeControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default: {
      const hex = char.codePointAt(0)?.toString(16);
      return `\\u${hex?.padStart(4, "0") ?? "0000"}`;
    }
  }
}

/**
 * 转义 JSON 字符串中的原始控制字符，并修复无效转义前的反斜杠。
 * @param json - 待修复的 JSON 文本。
 * @returns 修复后的文本；空字符串返回空字符串。
 * @remarks 仅修复字符串字面量，不保证返回值一定是完整有效的 JSON。
 */
export function repairJson(json: string): string {
  let repaired = "";
  let isInString = false;

  for (let index = 0; index < json.length; index++) {
    const char = json.charAt(index);

    if (!isInString) {
      repaired += char;
      if (char === '"') {
        isInString = true;
      }
      continue;
    }

    if (char === '"') {
      repaired += char;
      isInString = false;
      continue;
    }

    if (char === "\\") {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += "\\\\";
        continue;
      }

      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }

      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }

      repaired += "\\\\";
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
  }

  return repaired;
}

/**
 * 解析 JSON 文本，失败时尝试用 {@link repairJson} 修复后再次解析。
 *
 * @param json - 待解析的 JSON 文本。
 * @returns 解析结果，按调用方指定的类型 `T` 断言，不做运行时结构校验。
 * @throws SyntaxError 原文解析失败且修复后无变化时抛出原始错误；修复后的文本仍无法解析时抛出新的解析错误。
 */
export function parseJsonWithRepair<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    const repairedJson = repairJson(json);
    if (repairedJson !== json) {
      return JSON.parse(repairedJson) as T;
    }
    throw error;
  }
}

/**
 * 解析流式传输过程中可能不完整的 JSON 文本，始终返回结果而不抛出。
 *
 * @param partialJson - 流式接收的部分 JSON 文本。
 * @returns 解析结果；输入为空、仅含空白、解析结果为 `null`/`undefined` 或所有解析方式均失败时返回空对象。
 * @remarks 依次尝试：完整解析（含修复）、`partial-json` 部分解析原文、`partial-json` 部分解析修复后的文本。结果仅做类型断言，不做运行时结构校验。
 */
export function parseStreamingJson<T = Record<string, unknown>>(
  partialJson: string | undefined,
): T {
  if (!partialJson || partialJson.trim() === "") {
    return {} as T;
  }

  try {
    const result = parseJsonWithRepair<T>(partialJson);
    return (result ?? {}) as T;
  } catch {
    try {
      const result = partialParse(partialJson);
      return (result ?? {}) as T;
    } catch {
      try {
        const result = partialParse(repairJson(partialJson));
        return (result ?? {}) as T;
      } catch {
        return {} as T;
      }
    }
  }
}

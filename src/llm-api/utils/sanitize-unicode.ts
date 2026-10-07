/**
 * 移除字符串中未配对的 Unicode 代理字符。
 *
 * @param text - 待清理的文本。
 * @returns 移除未配对代理字符后的文本。
 * @remarks
 * 未配对的代理字符（没有匹配低代理 0xDC00-0xDFFF 的高代理 0xD800-0xDBFF，或反之）会导致许多 API 提供方的 JSON 序列化报错。
 * 合法的 emoji 及其他基本多文种平面之外的字符使用成对代理，不受本函数影响。
 *
 * @example
 * // 合法 emoji（成对代理）会被保留
 * sanitizeSurrogates("Hello 🙈 World") // => "Hello 🙈 World"
 *
 * // 未配对的高代理会被移除
 * const unpaired = String.fromCharCode(0xD83D); // 缺少低代理的高代理
 * sanitizeSurrogates(`Text ${unpaired} here`) // => "Text  here"
 */
export function sanitizeSurrogates(text: string): string {
  // 替换未配对的高代理项：0xD800-0xDBFF 后没有低代理项。
  // 替换未配对的低代理项：0xDC00-0xDFFF 前没有高代理项。
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

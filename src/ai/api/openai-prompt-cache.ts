/** OpenAI 提示缓存键允许的最大长度（按 Unicode 码点计）。 */
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/**
 * 将 OpenAI 提示缓存键截断到允许的最大长度。
 * @param key - 原始缓存键。
 * @returns 不超过 64 个 Unicode 码点时原样返回，否则返回前 64 个码点；未提供时返回 undefined。
 * @remarks 按码点而非 UTF-16 码元截断，避免拆开代理对。
 */
export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) {
    return key;
  }
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

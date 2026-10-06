/**
 * 计算字符串的快速确定性哈希，用于缩短长字符串。
 * @param str - 待哈希的字符串。
 * @returns 由两个 32 位哈希值的 36 进制表示拼接而成的字符串；相同输入始终得到相同结果。
 * @remarks 非加密哈希，不可用于安全场景。
 */
export function shortHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

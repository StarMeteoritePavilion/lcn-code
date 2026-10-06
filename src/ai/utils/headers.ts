/**
 * 将 `Headers` 对象转换为普通的键值对象。
 * @param headers - 待转换的请求或响应头。
 * @returns 以头名称为键的新对象；名称为 `Headers` 迭代得到的小写形式；迭代中重复出现的名称（如多个 `set-cookie`）仅保留最后一个值。
 */
export function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}

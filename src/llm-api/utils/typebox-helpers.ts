import { type TUnsafe, Type } from "typebox";

/**
 * 创建兼容 Google API 等不支持 anyOf/const 模式的提供方的字符串枚举 schema。
 *
 * @param values - 允许的字符串取值列表。
 * @param options - 可选配置：`description` 为 schema 描述，`default` 为默认值；值为空字符串等假值时不写入 schema。
 * @returns 形如 `{ type: "string", enum: values }` 的 TypeBox schema，静态类型为 `values` 元素的联合类型。
 *
 * @example
 * const OperationSchema = stringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "需要执行的操作"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function stringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values as unknown as T[number][],
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}

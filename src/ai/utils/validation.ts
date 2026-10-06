import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

const VALIDATOR_CACHE = new WeakMap<object, ReturnType<typeof Compile>>();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  items?: JsonSchemaObject | JsonSchemaObject[];
  additionalProperties?: boolean | JsonSchemaObject;
  allOf?: JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
}

/**
 * 读取 JSON Schema 声明的类型列表。
 *
 * @param schema - JSON Schema 对象。
 * @returns `type` 为字符串时返回单元素数组，为数组时返回其中的字符串项；未声明时返回空数组。
 */
function getSchemaTypes(schema: JsonSchemaObject): string[] {
  if (typeof schema.type === "string") {
    return [schema.type];
  }
  if (Array.isArray(schema.type)) {
    return schema.type.filter((type: string): type is string => typeof type === "string");
  }
  return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

/**
 * 获取子 Schema 的编译校验器，编译失败时不抛出。
 *
 * @param schema - 子 Schema。
 * @returns 编译后的校验器；编译失败（如包含无法解析的 `$ref`）时返回 `undefined`。
 */
function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
  try {
    return getValidator(schema as Tool["parameters"]);
  } catch {
    return undefined;
  }
}

/**
 * 按目标 JSON 类型宽松转换原始值。
 *
 * @param value - 待转换的值。
 * @param type - 目标 JSON Schema 类型。
 * @returns 转换后的值；无法转换或类型不受支持时原样返回。
 * @remarks 转换规则：`number`/`integer` 接受 `null`（转为 0）、可解析的非空数字字符串（`integer` 要求为整数）和布尔值（转为 1/0）；`boolean` 接受 `null`（转为 `false`）、`"true"`/`"false"` 和 1/0；`string` 接受 `null`（转为空字符串）、数字和布尔值；`null` 接受空字符串、0 和 `false`。
 */
function coercePrimitiveByType(value: unknown, type: string): unknown {
  switch (type) {
    case "number": {
      if (value === null) {
        return 0;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      return value;
    }
    case "integer": {
      if (value === null) {
        return 0;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) {
          return parsed;
        }
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      return value;
    }
    case "boolean": {
      if (value === null) {
        return false;
      }
      if (typeof value === "string") {
        if (value === "true") {
          return true;
        }
        if (value === "false") {
          return false;
        }
      }
      if (typeof value === "number") {
        if (value === 1) {
          return true;
        }
        if (value === 0) {
          return false;
        }
      }
      return value;
    }
    case "string": {
      if (value === null) {
        return "";
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return value;
    }
    case "null": {
      if (value === "" || value === 0 || value === false) {
        return null;
      }
      return value;
    }
    default:
      return value;
  }
}

/**
 * 按对象 Schema 原地转换对象的属性值。
 *
 * @param value - 待转换的对象，会被原地修改。
 * @param schema - 对象 Schema。
 * @remarks 仅转换已存在的属性；`additionalProperties` 为 Schema 对象时，未在 `properties` 中声明的属性按其转换。
 */
function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
  const properties = schema.properties;
  const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value)) {
        continue;
      }
      value[key] = coerceWithJsonSchema(value[key], propertySchema);
    }
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    for (const [key, propertyValue] of Object.entries(value)) {
      if (definedKeys.has(key)) {
        continue;
      }
      value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
    }
  }
}

/**
 * 按数组 Schema 原地转换数组元素。
 *
 * @param value - 待转换的数组，会被原地修改。
 * @param schema - 数组 Schema。
 * @remarks `items` 为数组（元组）时按位置转换，超出部分保持不变；为单个 Schema 时转换所有元素。
 */
function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
  if (Array.isArray(schema.items)) {
    for (let index = 0; index < value.length; index++) {
      const itemSchema = schema.items[index];
      if (!itemSchema) {
        continue;
      }
      value[index] = coerceWithJsonSchema(value[index], itemSchema);
    }
    return;
  }

  if (schema.items && typeof schema.items === "object") {
    for (let index = 0; index < value.length; index++) {
      value[index] = coerceWithJsonSchema(value[index], schema.items);
    }
  }
}

/**
 * 按联合 Schema（anyOf/oneOf）转换值。
 *
 * @param value - 待转换的值。
 * @param schemas - 联合中的候选 Schema。
 * @returns 值已满足任一候选时原样返回；否则返回第一个转换后能通过校验的结果；均不满足时返回原值。
 * @remarks 尝试转换时对值做深拷贝，不修改原值。
 */
function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
  for (const schema of schemas) {
    const validator = getSubSchemaValidator(schema);
    if (validator?.Check(value)) {
      return value;
    }
  }

  for (const schema of schemas) {
    const clonedValue = structuredClone(value);
    const coerced = coerceWithJsonSchema(clonedValue, schema);
    const validator = getSubSchemaValidator(schema);
    if (validator?.Check(coerced)) {
      return coerced;
    }
  }
  return value;
}

/**
 * 按普通 JSON Schema 递归地宽松转换值。
 *
 * @param value - 待转换的值；对象和数组会被原地修改。
 * @param schema - JSON Schema。
 * @returns 转换后的值；原始值可能被替换为新值，对象和数组返回同一引用。
 * @remarks 依次应用 `allOf`、`anyOf`、`oneOf`，再按声明类型转换原始值（多类型时若已匹配任一类型则不转换），最后递归处理对象属性与数组元素。
 */
function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
  let nextValue = value;

  if (Array.isArray(schema.allOf)) {
    for (const nested of schema.allOf) {
      nextValue = coerceWithJsonSchema(nextValue, nested);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
  }

  if (Array.isArray(schema.oneOf)) {
    nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
  }

  const schemaTypes = getSchemaTypes(schema);
  const matchesUnionMember =
    schemaTypes.length > 1 &&
    schemaTypes.some((schemaType: string): boolean => matchesJsonType(nextValue, schemaType));
  if (schemaTypes.length > 0 && !matchesUnionMember) {
    for (const schemaType of schemaTypes) {
      const coercedValue = coercePrimitiveByType(nextValue, schemaType);
      if (coercedValue !== nextValue) {
        nextValue = coercedValue;
        break;
      }
    }
  }

  if (
    schemaTypes.includes("object") &&
    typeof nextValue === "object" &&
    nextValue !== null &&
    !Array.isArray(nextValue)
  ) {
    applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
  }

  if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
    applySchemaArrayCoercion(nextValue, schema);
  }

  return nextValue;
}

/**
 * 递归删除可选属性上不被 Schema 接受的 `null` 值。
 *
 * @param value - 待处理的值，会被原地修改。
 * @param schema - 对应的 JSON Schema。
 * @remarks 仅删除非必填、非 `$ref` 且其 Schema 明确拒绝 `null` 的属性；其余属性继续递归处理。
 */
function normalizeOptionalNulls(value: unknown, schema: JsonSchemaObject): void {
  if (Array.isArray(value)) {
    if (Array.isArray(schema.items)) {
      for (let index = 0; index < value.length; index++) {
        const itemSchema = schema.items[index];
        if (itemSchema) {
          normalizeOptionalNulls(value[index], itemSchema);
        }
      }
    } else if (schema.items) {
      for (const item of value) {
        normalizeOptionalNulls(item, schema.items);
      }
    }
    return;
  }
  if (typeof value !== "object" || value === null || !schema.properties) {
    return;
  }

  const object = value as Record<string, unknown>;
  const required = new Set(schema.required ?? []);
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (!(key in object)) {
      continue;
    }
    if (
      object[key] === null &&
      !required.has(key) &&
      typeof (propertySchema as { $ref?: unknown }).$ref !== "string" &&
      getSubSchemaValidator(propertySchema)?.Check(null) === false
    ) {
      delete object[key];
    } else {
      normalizeOptionalNulls(object[key], propertySchema);
    }
  }
}

/**
 * 获取 Schema 的编译校验器，并按 Schema 对象引用缓存。
 *
 * @param schema - 工具参数 Schema。
 * @returns 编译后的校验器。
 * @throws Schema 无法编译时抛出 typebox 的编译错误。
 */
function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
  const key = schema as object;
  const cached = VALIDATOR_CACHE.get(key);
  if (cached) {
    return cached;
  }
  const validator = Compile(schema);
  VALIDATOR_CACHE.set(key, validator);
  return validator;
}

/**
 * 将校验错误转换为点分隔的属性路径。
 *
 * @param error - typebox 校验错误。
 * @returns 属性路径；`required` 错误会附加缺失的属性名，路径为空时返回 `"root"`。
 */
function formatValidationPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const requiredProperties = (error.params as { requiredProperties?: string[] })
      .requiredProperties;
    const requiredProperty = requiredProperties?.[0];
    if (requiredProperty) {
      const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return path || "root";
}

/**
 * 按名称查找工具，并依据其 Schema 校验工具调用参数。
 *
 * @param tools - 工具定义列表。
 * @param toolCall - 模型产生的工具调用。
 * @returns 校验通过（可能经过类型转换）的参数，参见 {@link validateToolArguments}。
 * @throws Error 找不到同名工具或参数校验失败时抛出。
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): unknown {
  const tool = tools.find((t: Tool): boolean => t.name === toolCall.name);
  if (!tool) {
    throw new Error(`Tool "${toolCall.name}" not found`);
  }
  return validateToolArguments(tool, toolCall);
}

/**
 * 依据工具的参数 Schema 校验工具调用参数。
 *
 * @param tool - 带参数 Schema 的工具定义。
 * @param toolCall - 模型产生的工具调用。
 * @returns 校验通过的参数副本，可能已删除不被接受的可选 `null` 属性并完成类型转换。
 * @throws Error 校验失败时抛出，信息包含各错误路径与原始参数。
 * @remarks 不修改 `toolCall.arguments`。先用 `Value.Convert` 转换；对非 TypeBox 构建的普通 JSON Schema，还会额外进行宽松类型转换。
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): unknown {
  const args = structuredClone(toolCall.arguments);
  normalizeOptionalNulls(args, tool.parameters as JsonSchemaObject);
  Value.Convert(tool.parameters, args);

  const validator = getValidator(tool.parameters);
  if (!Object.getOwnPropertySymbols(tool.parameters).includes(TYPEBOX_KIND)) {
    const coerced = coerceWithJsonSchema(args, tool.parameters as JsonSchemaObject);
    if (coerced !== args) {
      if (
        typeof args === "object" &&
        args !== null &&
        typeof coerced === "object" &&
        coerced !== null
      ) {
        for (const key of Object.keys(args)) {
          delete args[key];
        }
        Object.assign(args, coerced);
      } else {
        return validator.Check(coerced) ? coerced : args;
      }
    }
  }

  if (validator.Check(args)) {
    return args;
  }

  const validationErrors = validator.Errors(args);
  const errors =
    validationErrors
      .map(
        (error: TLocalizedValidationError): string =>
          `  - ${formatValidationPath(error)}: ${error.message}`,
      )
      .join("\n") || "Unknown validation error";

  const errorMessage =
    `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n` +
    JSON.stringify(toolCall.arguments, null, 2);

  throw new Error(errorMessage);
}

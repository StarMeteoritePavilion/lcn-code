import type { Tool } from "../types.ts";

interface JsonSchemaObject {
  [key: string]: unknown;
  type?: unknown;
  properties?: Record<string, JsonSchemaObject | undefined>;
  required?: unknown;
}

class UnsupportedStrictJsonSchemaError extends Error {}

/** 判断提供方严格模式是否拒绝某个 schema 关键字及其取值；拒绝时返回 true。 */
export type UnsupportedStrictSchemaKeywordCheck = (key: string, value: unknown) => boolean;

const UNSUPPORTED_STRICT_SCHEMA_KEYS = [
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "oneOf",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "prefixItems",
  "not",
  "if",
  "then",
  "else",
] as const;

/**
 * 判断值是否为 JSON Schema 对象节点（非 null、非数组的对象）。
 * @param value - 待判断的值。
 * @returns 是对象节点时返回 true，否则返回 false。
 */
function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 判断 schema 是否描述对象或数组等结构化类型。
 * @param schema - 待判断的 schema 节点。
 * @returns `type` 含 `"object"`/`"array"`，或声明了 `properties`/`items` 时返回 true，否则返回 false。
 */
function isStructuredSchema(schema: unknown): boolean {
  if (!isJsonSchemaObject(schema)) {
    return false;
  }
  const types =
    typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  return (
    types.includes("object") ||
    types.includes("array") ||
    schema.properties !== undefined ||
    schema.items !== undefined
  );
}

/**
 * 判断 schema 是否允许 null 值。
 * @param schema - 待判断的 schema 节点。
 * @returns `type` 含 `"null"`、`const` 为 null、`enum` 含 null，或任一 `anyOf` 分支允许 null 时返回 true，否则返回 false。
 */
function schemaAllowsNull(schema: unknown): boolean {
  if (!isJsonSchemaObject(schema)) {
    return false;
  }
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) {
    return true;
  }
  if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))) {
    return true;
  }
  return (
    Array.isArray(schema.anyOf) &&
    schema.anyOf.some((variant: unknown): boolean => schemaAllowsNull(variant))
  );
}

/**
 * 递归校验并就地改写 schema 节点，使其符合提供方严格模式要求的子集。
 * @param schema - 待改写的 schema 节点，会被就地修改。
 * @param isUnsupportedKeyword - 可选的协议特定关键字检查函数。
 * @throws 节点包含不支持的关键字、布尔 schema、元组、对象/数组联合、非 false 的 additionalProperties 或非法 required 时抛出 `UnsupportedStrictJsonSchemaError`。
 * @remarks 对象节点的所有属性都会被列入 `required`，原本可选且不允许 null 的属性改写为 `anyOf: [原 schema, { type: "null" }]`，并设置 `additionalProperties: false`。
 */
function makeJsonSchemaNodeStrict(
  schema: unknown,
  isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): void {
  if (!isJsonSchemaObject(schema)) {
    throw new UnsupportedStrictJsonSchemaError("boolean schemas are unsupported");
  }
  for (const key of UNSUPPORTED_STRICT_SCHEMA_KEYS) {
    if (schema[key] !== undefined) {
      throw new UnsupportedStrictJsonSchemaError(`${key} schemas are unsupported`);
    }
  }
  if (isUnsupportedKeyword) {
    for (const [key, value] of Object.entries(schema)) {
      if (isUnsupportedKeyword(key, value)) {
        throw new UnsupportedStrictJsonSchemaError(
          `${key}: ${JSON.stringify(value)} is unsupported`,
        );
      }
    }
  }

  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      throw new UnsupportedStrictJsonSchemaError("anyOf must contain at least one schema");
    }
    for (const variant of schema.anyOf) {
      if (isStructuredSchema(variant)) {
        throw new UnsupportedStrictJsonSchemaError("object and array unions are unsupported");
      }
      makeJsonSchemaNodeStrict(variant, isUnsupportedKeyword);
    }
  }

  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      throw new UnsupportedStrictJsonSchemaError("tuple schemas are unsupported");
    }
    makeJsonSchemaNodeStrict(schema.items, isUnsupportedKeyword);
  }

  const isObjectSchema = schema.type === "object";
  if (schema.properties !== undefined && !isObjectSchema) {
    throw new UnsupportedStrictJsonSchemaError("properties require type object");
  }
  if (!isObjectSchema) {
    return;
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new UnsupportedStrictJsonSchemaError(
      "schema-valued or true additionalProperties is unsupported",
    );
  }
  if (schema.properties !== undefined && !isJsonSchemaObject(schema.properties)) {
    throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some((key: unknown): boolean => typeof key !== "string"))
  ) {
    throw new UnsupportedStrictJsonSchemaError("object required must be a string array");
  }

  const properties = schema.properties ?? {};
  const propertyNames = Object.keys(properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  if ([...required].some((key: string): boolean => !propertyNames.includes(key))) {
    throw new UnsupportedStrictJsonSchemaError("required contains an unknown property");
  }
  for (const [key, property] of Object.entries(properties)) {
    makeJsonSchemaNodeStrict(property, isUnsupportedKeyword);
    if (!required.has(key) && !schemaAllowsNull(property)) {
      properties[key] = { anyOf: [property, { type: "null" }] };
    }
  }
  schema.required = propertyNames;
  schema.additionalProperties = false;
}

/**
 * 将工具参数 schema 转换为提供方约束采样所要求的严格子集。
 * @param schema - 工具参数 schema，不会被修改。
 * @param isUnsupportedKeyword - 可选的协议特定关键字检查函数，返回 true 表示该关键字不被支持。
 * @returns 转换后的 schema 深拷贝：所有属性均为必填，可选属性改为允许 null，且 `additionalProperties` 为 false。
 * @throws 根节点不是 `type: "object"` 或包含严格模式不支持的结构时抛出 `UnsupportedStrictJsonSchemaError`。
 */
export function makeStrictJsonSchema(
  schema: Tool["parameters"],
  isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): Record<string, unknown> {
  const cloned: unknown = structuredClone(schema);
  if (!isJsonSchemaObject(cloned)) {
    throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
  }
  makeJsonSchemaNodeStrict(cloned, isUnsupportedKeyword);
  if (cloned.type !== "object") {
    throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
  }
  return cloned;
}

export interface GrammarConstrainedSampling {
  format: "lark" | "regex";
  definition: string;
  inputProperty: string;
}

export interface GrammarToolInputJsonBuffer {
  input: string;
  isStarted: boolean;
  isClosed: boolean;
}

/**
 * 从语法约束工具调用的参数中取出语法输入字符串。
 * @param toolName - 工具名称，用于错误消息。
 * @param arguments_ - 工具调用参数。
 * @param inputProperty - 承载语法输入的参数名。
 * @returns 参数中的语法输入字符串。
 * @throws 该参数不是字符串时抛出 `Error`。
 */
export function getGrammarToolInput(
  toolName: string,
  arguments_: Record<string, unknown>,
  inputProperty: string,
): string {
  const input = arguments_[inputProperty];
  if (typeof input !== "string") {
    throw new Error(
      `Grammar tool call "${toolName}" requires argument "${inputProperty}" to be a string.`,
    );
  }
  return input;
}

/**
 * 将语法工具的原始输入增量转换为 `{"<inputProperty>":"..."}` 形式的 JSON 参数增量。
 * @param buffer - 记录已输出输入及开始/关闭状态的缓冲区，会被就地更新。
 * @param inputProperty - 承载语法输入的参数名。
 * @param nextInput - 截至目前的完整输入文本。
 * @param shouldClose - 是否在本次增量后闭合 JSON 对象。
 * @returns 需要追加的 JSON 片段；无新内容且无需闭合，或已闭合后以相同输入再次请求闭合时返回 undefined。
 * @throws 输入在闭合后发生变化，或新输入不是已输出输入的延续时抛出 `Error`。
 */
export function appendGrammarToolInputJsonDelta(
  buffer: GrammarToolInputJsonBuffer,
  inputProperty: string,
  nextInput: string,
  shouldClose: boolean,
): string | undefined {
  if (buffer.isClosed) {
    if (shouldClose && nextInput === buffer.input) {
      return undefined;
    }
    throw new Error(
      `grammar tool input for property "${inputProperty}" changed after it was closed`,
    );
  }
  if (!nextInput.startsWith(buffer.input)) {
    throw new Error(`grammar tool input for property "${inputProperty}" changed non-monotonically`);
  }

  const inputDelta = nextInput.slice(buffer.input.length);
  if (!shouldClose && inputDelta.length === 0) {
    return undefined;
  }

  let delta = "";
  if (!buffer.isStarted) {
    delta += `{${JSON.stringify(inputProperty)}:"`;
    buffer.isStarted = true;
  }
  delta += JSON.stringify(inputDelta).slice(1, -1);
  buffer.input = nextInput;

  if (shouldClose) {
    delta += '"}';
    buffer.isClosed = true;
  }
  return delta;
}

/**
 * 从工具参数 schema 推断承载语法输入的属性名。
 * @param tool - 语法约束工具。
 * @returns 唯一必填且类型为字符串的属性名。
 * @throws schema 不是对象、必填属性不止一个、缺少该属性定义或其类型不是字符串时抛出 `Error`。
 */
function inferGrammarInputProperty(tool: Tool): string {
  const schema = tool.parameters as JsonSchemaObject;
  if (schema.type !== "object") {
    throw new Error("grammar constrained sampling requires an object parameter schema");
  }
  if (
    !Array.isArray(schema.required) ||
    schema.required.length !== 1 ||
    typeof schema.required[0] !== "string"
  ) {
    throw new Error("grammar constrained sampling requires exactly one required string property");
  }

  const inputProperty = schema.required[0];
  if (!schema.properties?.[inputProperty]) {
    throw new Error(
      `grammar constrained sampling requires a properties entry for ${inputProperty}`,
    );
  }
  if (schema.properties[inputProperty]?.type !== "string") {
    throw new Error(`grammar constrained sampling property ${inputProperty} must have type string`);
  }
  return inputProperty;
}

/**
 * 为配置了 JSON Schema 约束采样的工具解析严格 schema。
 * @param tool - 待解析的工具。
 * @param canUseStrictMode - 当前提供方是否支持严格工具模式。
 * @param isUnsupportedKeyword - 可选的协议特定关键字检查函数。
 * @returns 严格 schema；工具未配置 JSON Schema 约束采样，或策略为 `"prefer"` 但无法使用严格模式时返回 undefined。
 * @throws 策略为 `"require"` 但提供方不支持严格模式或 schema 无法转换时抛出 `Error`；转换过程中的其他异常原样抛出。
 */
export function resolveStrictJsonSchema(
  tool: Tool,
  canUseStrictMode: boolean,
  isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): Record<string, unknown> | undefined {
  const config = tool.constrainedSampling;
  if (!config || config.type !== "json_schema") {
    return undefined;
  }

  if (canUseStrictMode) {
    try {
      return makeStrictJsonSchema(tool.parameters, isUnsupportedKeyword);
    } catch (error) {
      if (!(error instanceof UnsupportedStrictJsonSchemaError)) {
        throw error;
      }
      if (config.strict !== "require") {
        return undefined;
      }
      throw new Error(
        `Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`,
      );
    }
  }
  if (config.strict === "require") {
    throw new Error(
      `Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`,
    );
  }
  return undefined;
}

/**
 * 为配置了语法约束采样的工具解析 OpenAI 语法定义。
 * @param tool - 待解析的工具。
 * @param canUseOpenAIGrammarTools - 当前提供方是否支持 OpenAI 语法工具。
 * @returns 语法格式、定义与输入属性名，优先使用 Lark 变体，其次正则变体；工具未配置语法约束采样或提供方不支持时返回 undefined。
 * @throws 未提供非空的 Lark 或正则变体，或参数 schema 不满足单一必填字符串属性要求时抛出 `Error`。
 */
export function resolveGrammarConstrainedSampling(
  tool: Tool,
  canUseOpenAIGrammarTools: boolean,
): GrammarConstrainedSampling | undefined {
  const config = tool.constrainedSampling;
  if (!config || config.type !== "grammar") {
    return undefined;
  }

  if (!canUseOpenAIGrammarTools) {
    return undefined;
  }

  const larkDefinition = config.variants.openai_lark;
  const regexDefinition = config.variants.openai_regex;
  const hasLarkDefinition = typeof larkDefinition === "string" && larkDefinition.trim().length > 0;
  const hasRegexDefinition =
    typeof regexDefinition === "string" && regexDefinition.trim().length > 0;
  if (!hasLarkDefinition && !hasRegexDefinition) {
    throw new Error(
      `Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`,
    );
  }

  try {
    return {
      format: hasLarkDefinition ? "lark" : "regex",
      definition: hasLarkDefinition ? larkDefinition : regexDefinition!,
      inputProperty: inferGrammarInputProperty(tool),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: ${message}.`);
  }
}

/**
 * 为工具列表中的语法约束工具建立工具名到语法输入属性名的映射。
 * @param tools - 工具列表，未提供时视为空列表。
 * @param canUseOpenAIGrammarTools - 当前提供方是否支持 OpenAI 语法工具。
 * @returns 工具名到输入属性名的只读映射；不含语法约束工具或提供方不支持时为空映射。
 * @throws 某个语法约束工具配置无效时抛出 `Error`，语义同 `resolveGrammarConstrainedSampling`。
 */
export function createGrammarToolInputProperties(
  tools: Tool[] | undefined,
  canUseOpenAIGrammarTools: boolean,
): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  for (const tool of tools ?? []) {
    const grammar = resolveGrammarConstrainedSampling(tool, canUseOpenAIGrammarTools);
    if (grammar) {
      properties.set(tool.name, grammar.inputProperty);
    }
  }
  return properties;
}

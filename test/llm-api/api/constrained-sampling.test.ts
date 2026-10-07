import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { Type } from "typebox";
import {
  appendGrammarToolInputJsonDelta,
  createGrammarToolInputProperties,
  getGrammarToolInput,
  makeStrictJsonSchema,
  resolveGrammarConstrainedSampling,
  resolveStrictJsonSchema,
} from "../../../src/llm-api/api/constrained-sampling.ts";
import type { GrammarToolInputJsonBuffer } from "../../../src/llm-api/api/constrained-sampling.ts";
import type { Tool } from "../../../src/llm-api/types.ts";

/**
 * 创建带唯一必填字符串参数的独立工具。
 * @returns 支持 Lark 及正则的语法工具。
 */
function grammarTool(): Tool {
  return {
    name: "echo",
    description: "返回输入",
    parameters: Type.Object({ input: Type.String() }),
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: 'start: "hello"', openai_regex: "hello" },
    },
  };
}

describe("makeStrictJsonSchema", (): void => {
  it("将可选字段转为可空必填且不修改原 schema", (): void => {
    const optionalNote = Type.Optional(Type.String());
    const schema = Type.Object({ name: Type.String(), note: optionalNote });
    const original = structuredClone(schema);
    const strict = makeStrictJsonSchema(schema);
    deepStrictEqual(strict.required, ["name", "note"]);
    strictEqual(strict.additionalProperties, false);
    const properties = strict.properties as Record<string, Record<string, unknown>>;
    deepStrictEqual(properties.note?.anyOf, [{ type: "string" }, { type: "null" }]);
    deepStrictEqual(schema, original);
  });
  it("空对象形成空必填数组", (): void => {
    const strict = makeStrictJsonSchema(Type.Object({}));
    deepStrictEqual(strict, {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
  it("拒绝非对象、布尔节点、未知必填键及协议禁止关键词", (): void => {
    throws((): void => {
      makeStrictJsonSchema(Type.String());
    }, /root schema/);
    throws((): void => {
      makeStrictJsonSchema({
        type: "object",
        properties: { invalid: true },
      } as unknown as Tool["parameters"]);
    }, /boolean schemas/);
    throws((): void => {
      makeStrictJsonSchema({ type: "object", required: ["missing"] } as Tool["parameters"]);
    }, /unknown property/);
    throws((): void => {
      const schema = Type.Object({ name: Type.String({ format: "email" }) });
      makeStrictJsonSchema(schema, (key: string): boolean => key === "format");
    }, /format/);
  });
});

describe("getGrammarToolInput", (): void => {
  it("精确读取输入属性并保留文本", (): void => {
    strictEqual(getGrammarToolInput("echo", { input: "你好\n" }, "input"), "你好\n");
  });
  it("允许空输入字符串", (): void => {
    strictEqual(getGrammarToolInput("echo", { input: "" }, "input"), "");
  });
  it("缺失或非字符串输入抛出错误", (): void => {
    for (const args of [{}, { input: 1 }, { input: null }]) {
      throws((): void => {
        getGrammarToolInput("echo", args, "input");
      }, /requires argument "input"/);
    }
  });
});

describe("appendGrammarToolInputJsonDelta", (): void => {
  it("增量拼接及转义后能解析回原输入", (): void => {
    const buffer: GrammarToolInputJsonBuffer = { input: "", isStarted: false, isClosed: false };
    const first = appendGrammarToolInputJsonDelta(buffer, "input", '你"', false);
    const second = appendGrammarToolInputJsonDelta(buffer, "input", '你"\n好', true);
    const parsed: unknown = JSON.parse(`${first}${second}`);
    deepStrictEqual(parsed, { input: '你"\n好' });
    strictEqual(buffer.isClosed, true);
  });
  it("空增量无需输出，空输入仍可闭合并幂等完成", (): void => {
    const buffer: GrammarToolInputJsonBuffer = { input: "", isStarted: false, isClosed: false };
    strictEqual(appendGrammarToolInputJsonDelta(buffer, "input", "", false), undefined);
    strictEqual(appendGrammarToolInputJsonDelta(buffer, "input", "", true), '{"input":""}');
    strictEqual(appendGrammarToolInputJsonDelta(buffer, "input", "", true), undefined);
  });
  it("拒绝回退输入和闭合后继续改写", (): void => {
    const buffer: GrammarToolInputJsonBuffer = { input: "hello", isStarted: true, isClosed: false };
    throws((): void => {
      appendGrammarToolInputJsonDelta(buffer, "input", "hell", false);
    }, /non-monotonically/);
    appendGrammarToolInputJsonDelta(buffer, "input", "hello", true);
    throws((): void => {
      appendGrammarToolInputJsonDelta(buffer, "input", "hello!", true);
    }, /after it was closed/);
  });
});

describe("resolveStrictJsonSchema", (): void => {
  it("支持严格模式时返回严格对象", (): void => {
    const tool = grammarTool();
    tool.constrainedSampling = { type: "json_schema", strict: "require" };
    strictEqual(resolveStrictJsonSchema(tool, true)?.additionalProperties, false);
  });
  it("未配置及 prefer 不支持时返回 undefined", (): void => {
    const tool = grammarTool();
    tool.constrainedSampling = false;
    strictEqual(resolveStrictJsonSchema(tool, true), undefined);
    tool.constrainedSampling = { type: "json_schema", strict: "prefer" };
    strictEqual(resolveStrictJsonSchema(tool, false), undefined);
    tool.parameters = Type.String();
    strictEqual(resolveStrictJsonSchema(tool, true), undefined);
  });
  it("require 不支持或 schema 非法时拒绝降级", (): void => {
    const tool = grammarTool();
    tool.constrainedSampling = { type: "json_schema", strict: "require" };
    throws((): void => {
      resolveStrictJsonSchema(tool, false);
    }, /strict tools are unsupported/);
    tool.parameters = Type.String();
    throws((): void => {
      resolveStrictJsonSchema(tool, true);
    }, /requires JSON-schema/);
  });
});

describe("resolveGrammarConstrainedSampling", (): void => {
  it("优先 Lark 并读取唯一必填属性", (): void => {
    const grammar = resolveGrammarConstrainedSampling(grammarTool(), true);
    deepStrictEqual(grammar, {
      format: "lark",
      definition: 'start: "hello"',
      inputProperty: "input",
    });
  });
  it("不支持时不解析，Lark 为空时使用正则", (): void => {
    const tool = grammarTool();
    strictEqual(resolveGrammarConstrainedSampling(tool, false), undefined);
    tool.constrainedSampling = {
      type: "grammar",
      variants: { openai_lark: " ", openai_regex: "hello" },
    };
    strictEqual(resolveGrammarConstrainedSampling(tool, true)?.format, "regex");
    tool.constrainedSampling = false;
    strictEqual(resolveGrammarConstrainedSampling(tool, true), undefined);
  });
  it("空变体或缺少唯一字符串参数时报错", (): void => {
    const tool = grammarTool();
    tool.constrainedSampling = { type: "grammar", variants: {} };
    throws((): void => {
      resolveGrammarConstrainedSampling(tool, true);
    }, /no supported grammar/);
    tool.constrainedSampling = { type: "grammar", variants: { openai_regex: "hello" } };
    tool.parameters = Type.Object({ input: Type.Number() });
    throws((): void => {
      resolveGrammarConstrainedSampling(tool, true);
    }, /must have type string/);
  });
});

describe("createGrammarToolInputProperties", (): void => {
  it("建立工具名称到输入属性的精确映射", (): void => {
    const properties = createGrammarToolInputProperties([grammarTool()], true);
    strictEqual(properties.get("echo"), "input");
    strictEqual(properties.size, 1);
  });
  it("缺省列表或不支持语法工具时返回空映射", (): void => {
    strictEqual(createGrammarToolInputProperties(undefined, true).size, 0);
    const properties = createGrammarToolInputProperties([grammarTool()], false);
    strictEqual(properties.size, 0);
  });
  it("传递非法工具的解析错误", (): void => {
    const tool = grammarTool();
    tool.parameters = Type.Object({});
    throws((): void => {
      createGrammarToolInputProperties([tool], true);
    }, /exactly one required/);
  });
});

describe("严格 schema 递归与错误分支", (): void => {
  it("保留允许 null 的可选字段并递归转换数组元素", (): void => {
    const nullable = [
      { type: ["string", "null"] },
      { const: null },
      { enum: ["a", null] },
      { anyOf: [{ type: "string" }, { type: "null" }] },
    ];
    for (const property of nullable) {
      const strict = makeStrictJsonSchema({
        type: "object",
        properties: { item: property },
      } as Tool["parameters"]);
      deepStrictEqual(strict.properties, { item: property });
    }
    const result = makeStrictJsonSchema({
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "object", properties: { item: { type: "string" } } },
        },
      },
      required: ["list"],
    } as Tool["parameters"]);
    deepStrictEqual(result.properties, {
      list: {
        type: "array",
        items: {
          type: "object",
          properties: { item: { anyOf: [{ type: "string" }, { type: "null" }] } },
          required: ["item"],
          additionalProperties: false,
        },
      },
    });
  });
  it("非法对象、联合、元组和必填字段拒绝且 prefer 只降级不支持结构", (): void => {
    const invalid: Array<{ schema: unknown; error: RegExp }> = [
      {
        schema: { type: "object", properties: { x: { anyOf: [true] } } },
        error: /boolean schemas/,
      },
      { schema: null, error: /root schema/ },
      { schema: { type: "object", $ref: "#/other" }, error: /unsupported/ },
      { schema: { type: "object", properties: [] }, error: /schema map/ },
      { schema: { type: "object", additionalProperties: true }, error: /additionalProperties/ },
      { schema: { type: "object", required: "x" }, error: /string array/ },
      { schema: { type: "object", required: [1] }, error: /string array/ },
      { schema: { type: "object", properties: { x: { anyOf: [] } } }, error: /at least one/ },
      { schema: { type: "object", properties: { x: { anyOf: {} } } }, error: /at least one/ },
      {
        schema: { type: "object", properties: { x: { anyOf: [{ type: ["object", "null"] }] } } },
        error: /unions/,
      },
      {
        schema: { type: "object", properties: { x: { anyOf: [{ properties: {} }] } } },
        error: /unions/,
      },
      {
        schema: { type: "object", properties: { x: { type: "array", items: [] } } },
        error: /tuple/,
      },
      {
        schema: { type: "object", properties: { x: { type: "string", properties: {} } } },
        error: /properties require/,
      },
    ];
    for (const entry of invalid) {
      throws((): void => {
        makeStrictJsonSchema(entry.schema as Tool["parameters"]);
      }, entry.error);
    }
    const configured = grammarTool();
    configured.constrainedSampling = { type: "json_schema", strict: "prefer" };
    configured.parameters = { type: "object", additionalProperties: true } as Tool["parameters"];
    strictEqual(resolveStrictJsonSchema(configured, true), undefined);
    const failure = new Error("检查函数异常");
    throws(
      (): void => {
        resolveStrictJsonSchema(configured, true, (): boolean => {
          throw failure;
        });
      },
      (error: unknown): boolean => error === failure,
    );
  });
  it("语法工具 schema 必须为对象且有唯一必填字符串输入", (): void => {
    const cases: Array<{ parameters: unknown; error: RegExp }> = [
      { parameters: { type: "object", required: ["missing"] }, error: /properties entry/ },
      { parameters: { type: "string" }, error: /object parameter schema/ },
      {
        parameters: {
          type: "object",
          properties: { input: { type: "string" }, extra: { type: "string" } },
          required: ["input", "extra"],
        },
        error: /exactly one/,
      },
      {
        parameters: { type: "object", properties: { input: { type: "string" } }, required: [] },
        error: /exactly one/,
      },
    ];
    for (const entry of cases) {
      const configured = grammarTool();
      configured.parameters = entry.parameters as Tool["parameters"];
      throws((): void => {
        resolveGrammarConstrainedSampling(configured, true);
      }, entry.error);
    }
  });
});

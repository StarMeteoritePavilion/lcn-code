import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import {
  formatThrownValue,
  extractDiagnosticError,
  createAssistantMessageDiagnostic,
  appendAssistantMessageDiagnostic,
} from "../../../src/llm-api/utils/diagnostics.ts";

describe("formatThrownValue", (): void => {
  it("错误与字符串保留消息", (): void => {
    strictEqual(formatThrownValue(new Error("错误")), "错误");
    strictEqual(formatThrownValue("消息"), "消息");
  });
  it("空错误消息回退错误名称", (): void => {
    strictEqual(formatThrownValue(new TypeError()), "TypeError");
  });
  it("非 Error 抛出值仍可格式化", (): void => {
    strictEqual(formatThrownValue(null), "null");
    strictEqual(formatThrownValue(undefined), "undefined");
    strictEqual(formatThrownValue(1), "1");
  });
});
describe("extractDiagnosticError", (): void => {
  it("提取名称、堆栈和精确错误码", (): void => {
    const error = Object.assign(new Error("错误"), { code: "E_TEST" });
    const result = extractDiagnosticError(error);
    strictEqual(result.message, "错误");
    strictEqual(result.code, "E_TEST");
    strictEqual(result.stack, error.stack);
  });
  it("空错误消息回退名称，数字错误码保留", (): void => {
    strictEqual(extractDiagnosticError(Object.assign(new TypeError(), { code: 0 })).code, 0);
    strictEqual(extractDiagnosticError(new TypeError()).message, "TypeError");
  });
  it("忽略错误类型的 code 并接受非 Error 值", (): void => {
    strictEqual(extractDiagnosticError(Object.assign(new Error(), { code: {} })).code, undefined);
    deepStrictEqual(extractDiagnosticError(null), { name: "ThrownValue", message: "null" });
  });
});
describe("createAssistantMessageDiagnostic", (): void => {
  it("保存类型、错误与详情", (): void => {
    const result = createAssistantMessageDiagnostic("失败", new Error("错误"), { retry: 1 });
    strictEqual(result.type, "失败");
    strictEqual(result.error?.message, "错误");
    deepStrictEqual(result.details, { retry: 1 });
  });
  it("缺少详情时仍有毫秒时间戳", (): void => {
    const before = Date.now();
    const result = createAssistantMessageDiagnostic("", "");
    ok(result.timestamp >= before && result.timestamp <= Date.now());
    strictEqual(result.details, undefined);
  });
  it("非 Error 的抛出值也产生诊断", (): void => {
    strictEqual(createAssistantMessageDiagnostic("失败", undefined).error?.name, "ThrownValue");
  });
});
describe("appendAssistantMessageDiagnostic", (): void => {
  it("追加到现有记录末尾但不修改原数组", (): void => {
    const first = createAssistantMessageDiagnostic("一", "一");
    const previous = [first];
    const message = { diagnostics: previous };
    const second = createAssistantMessageDiagnostic("二", "二");
    appendAssistantMessageDiagnostic(message, second);
    deepStrictEqual(message.diagnostics, [first, second]);
    deepStrictEqual(previous, [first]);
  });
  it("缺少记录时创建数组", (): void => {
    const message: { diagnostics?: ReturnType<typeof createAssistantMessageDiagnostic>[] } = {};
    const entry = createAssistantMessageDiagnostic("一", null);
    appendAssistantMessageDiagnostic(message, entry);
    deepStrictEqual(message.diagnostics, [entry]);
  });
  it("非 Error 诊断保持原始描述", (): void => {
    const message = { diagnostics: [] as ReturnType<typeof createAssistantMessageDiagnostic>[] };
    appendAssistantMessageDiagnostic(message, createAssistantMessageDiagnostic("失败", 42));
    strictEqual(message.diagnostics[0]?.error?.message, "42");
  });
});

describe("诊断名称边界", (): void => {
  it("空错误名称省略，非字符串或数字code不写入", (): void => {
    const error = new Error("消息");
    error.name = "";
    const result = extractDiagnosticError(error);
    strictEqual(result.name, undefined);
    strictEqual(result.message, "消息");
    strictEqual(result.code, undefined);
  });
});

import { match, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { getPiUserAgent } from "../../../src/llm-api/utils/pi-user-agent.ts";

describe("getPiUserAgent", (): void => {
  it("Node环境返回平台信息且重复调用一致", (): void => {
    match(getPiUserAgent(), /^pi \(.+; .+\)$/);
    strictEqual(getPiUserAgent(), getPiUserAgent());
  });
  it("缺少process时返回浏览器标识", (): void => {
    const url = new URL("../../../src/llm-api/utils/pi-user-agent.js", import.meta.url).href;
    const script = `globalThis.process = undefined; const {getPiUserAgent} = await import(${JSON.stringify(url)}); console.log(getPiUserAgent());`;
    strictEqual(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      }).trim(),
      "pi (browser)",
    );
  });
  it("运行时缺少getBuiltinModule时安全回退", (): void => {
    const url = new URL("../../../src/llm-api/utils/pi-user-agent.js", import.meta.url).href;
    const script = `process.getBuiltinModule = undefined; const {getPiUserAgent} = await import(${JSON.stringify(url)}); console.log(getPiUserAgent());`;
    strictEqual(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      }).trim(),
      "pi (browser)",
    );
  });
});

describe("非Node运行时识别", (): void => {
  it("缺少版本或没有Node和Bun标识时不加载操作系统模块", (): void => {
    const url = new URL("../../../src/llm-api/utils/pi-user-agent.js", import.meta.url).href;
    for (const setup of ["globalThis.process = {}", "globalThis.process = { versions: {} }"]) {
      const script = `${setup}; const {getPiUserAgent} = await import(${JSON.stringify(url)}); console.log(getPiUserAgent());`;
      const actual = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      });
      strictEqual(actual.trim(), "pi (browser)");
    }
  });
  it("Bun标识可加载内建模块，首次结果被缓存", (): void => {
    const url = new URL("../../../src/llm-api/utils/pi-user-agent.js", import.meta.url).href;
    const script = `let calls = 0; globalThis.process = { versions: { bun: "1" }, getBuiltinModule(id) { if (id !== "node:os") { throw new Error("错误模块"); } calls++; return { platform: () => "test", release: () => "1", arch: () => "arm64" }; } }; const {getPiUserAgent} = await import(${JSON.stringify(url)}); const first = getPiUserAgent(); process.getBuiltinModule = () => { throw new Error("重复加载"); }; console.log(JSON.stringify([first, getPiUserAgent(), calls]));`;
    const actual = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    strictEqual(actual.trim(), '["pi (test 1; arm64)","pi (test 1; arm64)",1]');
  });
});

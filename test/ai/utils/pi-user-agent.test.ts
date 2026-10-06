import { match, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { getPiUserAgent } from "../../../src/ai/utils/pi-user-agent.ts";

describe("getPiUserAgent", (): void => {
  it("Node环境返回平台信息且重复调用一致", (): void => {
    match(getPiUserAgent(), /^pi \(.+; .+\)$/);
    strictEqual(getPiUserAgent(), getPiUserAgent());
  });
  it("缺少process时返回浏览器标识", (): void => {
    const url = new URL("../../../src/ai/utils/pi-user-agent.js", import.meta.url).href;
    const script = `globalThis.process = undefined; const {getPiUserAgent} = await import(${JSON.stringify(url)}); console.log(getPiUserAgent());`;
    strictEqual(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      }).trim(),
      "pi (browser)",
    );
  });
  it("运行时缺少getBuiltinModule时安全回退", (): void => {
    const url = new URL("../../../src/ai/utils/pi-user-agent.js", import.meta.url).href;
    const script = `process.getBuiltinModule = undefined; const {getPiUserAgent} = await import(${JSON.stringify(url)}); console.log(getPiUserAgent());`;
    strictEqual(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      }).trim(),
      "pi (browser)",
    );
  });
});

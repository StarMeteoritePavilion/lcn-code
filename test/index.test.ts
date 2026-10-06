import { describe, it } from "node:test";
import { strictEqual } from "node:assert";

import { greet } from "../src/index.ts";

describe("greet", () => {
  it("不传参数时返回默认问候语", () => {
    const result = greet();
    strictEqual(result, "Hello World!");
  });

  it("传入名称时返回对应问候语", () => {
    const result = greet("lcn-code");
    strictEqual(result, "Hello lcn-code!");
  });

  it("传入空字符串时返回不含名称的问候语", () => {
    const result = greet("");
    strictEqual(result, "Hello !");
  });
});

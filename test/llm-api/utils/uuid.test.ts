import { match, notStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it, type TestContext } from "node:test";
import { uuidv7 } from "../../../src/llm-api/utils/uuid.ts";

describe("uuidv7", (): void => {
  it("同一时间戳生成不同UUID并编码版本和变体", (): void => {
    const first = uuidv7(1000);
    const second = uuidv7(1000);
    match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    notStrictEqual(first, second);
    strictEqual(first.slice(0, 13), "00000000-03e8");
  });
  it("接受时间戳两端并阻止普通时钟倒退", (context: TestContext): void => {
    strictEqual(uuidv7(0).slice(0, 13), "00000000-0000");
    strictEqual(uuidv7(0xffffffffffff).slice(0, 13), "ffffffff-ffff");
    context.mock.method(Date, "now", (): number => 2000);
    const first = uuidv7();
    context.mock.method(Date, "now", (): number => 1000);
    strictEqual(uuidv7().slice(0, 13), first.slice(0, 13));
  });
  it("拒绝超范围、非整数及非有限时间戳", (): void => {
    for (const value of [-1, 0.5, 0x1000000000000, NaN, Infinity]) {
      throws((): string => uuidv7(value), RangeError);
    }
  });
});

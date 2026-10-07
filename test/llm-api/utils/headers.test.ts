import { deepStrictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { headersToRecord } from "../../../src/llm-api/utils/headers.ts";

describe("headersToRecord", (): void => {
  it("按照 Headers 规范输出小写名称及合并值", (): void => {
    const headers = new Headers({ "X-Test": "first" });
    headers.append("X-Test", "second");
    deepStrictEqual(headersToRecord(headers), { "x-test": "first, second" });
  });
  it("空头返回空对象，重复set-cookie只保留最后值", (): void => {
    deepStrictEqual(headersToRecord(new Headers()), {});
    const headers = new Headers();
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    deepStrictEqual(headersToRecord(headers), { "set-cookie": "b=2" });
  });
  it("错误输入不会被当作空头", (): void => {
    throws((): object => headersToRecord(null as unknown as Headers), TypeError);
  });
});

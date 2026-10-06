import { strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  contentText,
  getSystemMessageText,
  renderSystemMessageUpdate,
} from "../../../src/ai/utils/text.ts";
import type { SystemMessage } from "../../../src/ai/types.ts";

describe("contentText", (): void => {
  it("只拼接文本并接受自定义分隔符", (): void => {
    strictEqual(
      contentText(
        [
          { type: "text", text: "一" },
          { type: "thinking", thinking: "隐藏" },
          { type: "text", text: "二" },
        ],
        "|",
      ),
      "一|二",
    );
  });
  it("空数组及空文本返回空串，普通文本原样返回", (): void => {
    strictEqual(contentText([]), "");
    strictEqual(contentText(""), "");
    strictEqual(contentText("原文"), "原文");
  });
  it("错误类型不会被当作空文本", (): void => {
    throws((): string => contentText(null as unknown as string), TypeError);
  });
});
describe("getSystemMessageText", (): void => {
  it("按正文及分节顺序渲染并跳过空值", (): void => {
    strictEqual(
      getSystemMessageText({
        role: "system",
        content: "正文",
        sections: { 一: "分节", 二: null, 三: "" },
        timestamp: 0,
      }),
      "正文\n\n分节",
    );
  });
  it("无正文分节时返回空串", (): void => {
    strictEqual(getSystemMessageText({ role: "system", content: [], timestamp: 0 }), "");
  });
  it("错误内容结构抛出而不生成提示词", (): void => {
    throws(
      (): string =>
        getSystemMessageText({
          role: "system",
          content: null,
          timestamp: 0,
        } as unknown as SystemMessage),
      TypeError,
    );
  });
});
describe("renderSystemMessageUpdate", (): void => {
  it("渲染正文、分节更新和删除说明", (): void => {
    strictEqual(
      renderSystemMessageUpdate({
        role: "system",
        content: "正文",
        sections: { one: "内容", two: null },
        timestamp: 0,
      }),
      '正文\n\nUpdated system prompt section "one":\n\n内容\n\nRemoved system prompt section "two".',
    );
  });
  it("无更新返回空串", (): void => {
    strictEqual(renderSystemMessageUpdate({ role: "system", content: "", timestamp: 0 }), "");
  });
  it("错误输入抛出而不生成提示词", (): void => {
    throws((): string => renderSystemMessageUpdate(null as unknown as SystemMessage), TypeError);
  });
});

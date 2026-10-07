import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import * as transcript from "../../../src/llm-api/utils/transcript.ts";
import type { Message, SystemMessage, Tool } from "../../../src/llm-api/types.ts";
import { tool } from "../helpers.ts";

/**
 * 创建用于回放测试的系统消息。
 * @param content - 系统正文。
 * @param changes - 分节与工具变化。
 * @returns 系统消息。
 */
function system(content: string, changes: Partial<SystemMessage> = {}): SystemMessage {
  return { role: "system", content, timestamp: 0, ...changes };
}

describe("createInitialSystemMessage", (): void => {
  it("提示词与工具组成开头系统消息", (): void => {
    const target = tool();
    deepStrictEqual(
      transcript.createInitialSystemMessage("提示", [target]),
      system("提示", { toolsAdded: [target] }),
    );
  });
  it("空提示及空工具返回undefined", (): void => {
    strictEqual(transcript.createInitialSystemMessage("", []), undefined);
    strictEqual(transcript.createInitialSystemMessage(undefined, undefined), undefined);
  });
  it("未提供提示而仅有工具仍创建声明", (): void => {
    strictEqual(transcript.createInitialSystemMessage(undefined, [tool()])?.content, "");
  });
});
describe("normalizeContext", (): void => {
  it("将提示和工具放在用户消息之前", (): void => {
    const messages: Message[] = [{ role: "user", content: "用户", timestamp: 1 }];
    const result = transcript.normalizeContext({ systemPrompt: "系统", messages, tools: [tool()] });
    strictEqual(result.messages[0]?.role, "system");
    strictEqual(result.messages[1], messages[0]);
  });
  it("空上下文保持消息数组引用", (): void => {
    const messages: Message[] = [];
    strictEqual(transcript.normalizeContext({ messages }).messages, messages);
  });
  it("缺少必需上下文对象不生成请求", (): void => {
    throws((): unknown => transcript.normalizeContext(null as never), TypeError);
  });
});
describe("getInitialSystemMessage与withoutInitialSystemMessage", (): void => {
  it("只读取和移除开头的系统消息", (): void => {
    const head = system("系统");
    const user: Message = { role: "user", content: "用户", timestamp: 1 };
    const messages = [head, user];
    strictEqual(transcript.getInitialSystemMessage(messages), head);
    deepStrictEqual(transcript.withoutInitialSystemMessage(messages), [user]);
  });
  it("空列表返回undefined并保持引用", (): void => {
    const messages: Message[] = [];
    strictEqual(transcript.getInitialSystemMessage(messages), undefined);
    strictEqual(transcript.withoutInitialSystemMessage(messages), messages);
  });
  it("后续系统消息不被错当作开头", (): void => {
    const messages: Message[] = [{ role: "user", content: "用户", timestamp: 1 }, system("后续")];
    strictEqual(transcript.getInitialSystemMessage(messages), undefined);
    strictEqual(transcript.withoutInitialSystemMessage(messages), messages);
  });
});
describe("系统消息与工具回放", (): void => {
  it("getCurrentTools/getDeclaredTools先移除后新增并保留精确名称", (): void => {
    const first = tool("A");
    const replacement = { ...first, description: "更新" };
    const second = tool("a");
    const messages = [
      system("一", { toolsAdded: [first, second] }),
      system("二", { toolsRemoved: [{ name: "A" }], toolsAdded: [replacement] }),
    ];
    deepStrictEqual(transcript.getCurrentTools(messages), [second, replacement]);
    deepStrictEqual(transcript.getDeclaredTools(messages), [replacement, second]);
  });
  it("getCurrentSystemMessage/getCurrentSystemPrompt合并正文并更新删除分节", (): void => {
    const messages = [
      system("一", { sections: { one: "旧", two: "移除" }, timestamp: 10 }),
      system("二", { sections: { one: "新", two: null } }),
    ];
    deepStrictEqual(
      transcript.getCurrentSystemMessage(messages),
      system("一\n\n二", { sections: { one: "新" }, timestamp: 10 }),
    );
    strictEqual(transcript.getCurrentSystemPrompt(messages), "一\n\n二\n\n新");
  });
  it("空列表与非系统角色均无提示或工具", (): void => {
    for (const messages of [[], [{ role: "未知角色" }]]) {
      deepStrictEqual(transcript.getCurrentTools(messages), []);
      deepStrictEqual(transcript.getDeclaredTools(messages), []);
      strictEqual(transcript.getCurrentSystemMessage(messages), undefined);
      strictEqual(transcript.getCurrentSystemPrompt(messages), "");
    }
  });
});
describe("collapseSystemMessages与resolveTranscript", (): void => {
  it("不支持中途系统消息时合并且保留用户消息", (): void => {
    const user: Message = { role: "user", content: "用户", timestamp: 1 };
    const context = transcript.normalizeContext({ messages: [system("一"), user, system("二")] });
    deepStrictEqual(transcript.collapseSystemMessages(context).messages, [
      system("一\n\n二"),
      user,
    ]);
    deepStrictEqual(transcript.resolveTranscript(context, false).messages, [
      system("一\n\n二"),
      user,
    ]);
    strictEqual(transcript.resolveTranscript(context, true), context);
  });
  it("无系统消息的空会话保持为空", (): void => {
    const context = transcript.normalizeContext({ messages: [] });
    deepStrictEqual(transcript.collapseSystemMessages(context).messages, []);
    deepStrictEqual(transcript.resolveTranscript(context, undefined).messages, []);
  });
  it("错误上下文拒绝回放", (): void => {
    throws((): unknown => transcript.collapseSystemMessages(null as never), TypeError);
    throws((): unknown => transcript.resolveTranscript(null as never, false), TypeError);
  });
});
describe("toToolDeclaration与declarationsEqual", (): void => {
  it("拷贝参数并比较精确声明", (): void => {
    const target = tool();
    const declaration = transcript.toToolDeclaration(target);
    strictEqual(declaration.parameters === target.parameters, false);
    strictEqual(transcript.declarationsEqual(target, declaration), true);
    declaration.description = "修改";
    strictEqual(transcript.declarationsEqual(target, declaration), false);
  });
  it("空参数schema和语法声明可复制比较", (): void => {
    const target = {
      ...tool(),
      constrainedSampling: { type: "grammar" as const, variants: { openai_regex: "[0-9]+" } },
    };
    const declaration = transcript.toToolDeclaration(target);
    deepStrictEqual(declaration.constrainedSampling, target.constrainedSampling);
    strictEqual(transcript.declarationsEqual(target, declaration), true);
  });
  it("循环schema无法声明或比较", (): void => {
    const target = tool();
    Reflect.set(target.parameters, "cycle", target.parameters);
    throws((): unknown => transcript.toToolDeclaration(target), TypeError);
    throws((): boolean => transcript.declarationsEqual(target, tool()), TypeError);
  });
});
describe("getToolStateChanges", (): void => {
  it("定义更新表现为移除和重新新增", (): void => {
    const before = tool("A");
    const after = { ...before, description: "更新" };
    const result = transcript.getToolStateChanges([before], [after, tool("B")]);
    deepStrictEqual(result.toolsRemoved, [{ name: "A" }]);
    deepStrictEqual(
      result.toolsAdded.map((entry: Tool): string => entry.name),
      ["A", "B"],
    );
  });
  it("空状态及相同声明没有变化", (): void => {
    deepStrictEqual(transcript.getToolStateChanges([], []), { toolsAdded: [], toolsRemoved: [] });
    deepStrictEqual(transcript.getToolStateChanges([tool()], [tool()]), {
      toolsAdded: [],
      toolsRemoved: [],
    });
  });
  it("删除与大小写变化按精确名称处理", (): void => {
    deepStrictEqual(transcript.getToolStateChanges([tool("A")], [tool("a")]).toolsRemoved, [
      { name: "A" },
    ]);
  });
});
describe("hasToolRedefinitions与hasNonAdditiveToolChanges", (): void => {
  it("不同定义的同名工具属于重定义及非追加变化", (): void => {
    const target = tool();
    const messages = [
      system("", { toolsAdded: [target] }),
      system("", { toolsAdded: [{ ...target, description: "新" }] }),
    ];
    strictEqual(transcript.hasToolRedefinitions(messages), true);
    strictEqual(transcript.hasNonAdditiveToolChanges(messages), true);
  });
  it("空列表和单次声明属于追加变化", (): void => {
    for (const messages of [[], [system("", { toolsAdded: [tool()] })]]) {
      strictEqual(transcript.hasToolRedefinitions(messages), false);
      strictEqual(transcript.hasNonAdditiveToolChanges(messages), false);
    }
  });
  it("相同定义重申或删除不能原位追加，但不是重定义", (): void => {
    const messages = [system("", { toolsAdded: [tool()] }), system("", { toolsAdded: [tool()] })];
    strictEqual(transcript.hasToolRedefinitions(messages), false);
    strictEqual(transcript.hasNonAdditiveToolChanges(messages), true);
    strictEqual(
      transcript.hasNonAdditiveToolChanges([system("", { toolsRemoved: [{ name: "未知" }] })]),
      true,
    );
  });
});
describe("resolveTranscriptTools", (): void => {
  it("支持原位追加时只发送开头工具", (): void => {
    const first = tool("一");
    const second = tool("二");
    const messages = [system("", { toolsAdded: [first] }), system("", { toolsAdded: [second] })];
    deepStrictEqual(transcript.resolveTranscriptTools(messages, true), {
      requestTools: [first],
      isAnchoringAdditions: true,
    });
    deepStrictEqual(transcript.resolveTranscriptTools(messages, false), {
      requestTools: [first, second],
      isAnchoringAdditions: false,
    });
  });
  it("空对话的工具列表为空", (): void => {
    deepStrictEqual(transcript.resolveTranscriptTools([], true), {
      requestTools: [],
      isAnchoringAdditions: true,
    });
  });
  it("工具删除使原位追加降级为当前集合", (): void => {
    const messages = [
      system("", { toolsAdded: [tool()] }),
      system("", { toolsRemoved: [{ name: "测试工具" }] }),
    ];
    deepStrictEqual(transcript.resolveTranscriptTools(messages, true), {
      requestTools: [],
      isAnchoringAdditions: false,
    });
  });
});

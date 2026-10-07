import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  EventStream,
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "../../../src/llm-api/utils/event-stream.ts";
import { assistant } from "../helpers.ts";

describe("EventStream", (): void => {
  it("按FIFO读取缓冲事件并在完成事件兑现结果", async (): Promise<void> => {
    const stream = new EventStream<number>(
      (value: number): boolean => value === 3,
      (value: number): number => value,
    );
    stream.push(1);
    stream.push(2);
    stream.push(3);
    stream.push(4);
    const values: number[] = [];
    for await (const value of stream) {
      values.push(value);
    }
    deepStrictEqual(values, [1, 2, 3]);
    strictEqual(await stream.result(), 3);
  });
  it("空流end结束所有等待者，显式结果可为零", async (): Promise<void> => {
    const stream = new EventStream<number>(
      (value: number): boolean => value === 3,
      (value: number): number => value,
    );
    const first = stream[Symbol.asyncIterator]();
    const second = stream[Symbol.asyncIterator]();
    const pending = [first.next(), second.next()];
    stream.end(0);
    for (const result of await Promise.all(pending)) {
      strictEqual(result.done, true);
    }
    strictEqual(await stream.result(), 0);
    stream.end(1);
    strictEqual(await stream.result(), 0);
  });
  it("等待者收到新事件，提取结果异常原样抛出", async (): Promise<void> => {
    const stream = new EventStream<number>(
      (value: number): boolean => value === 0,
      (value: number): number => value,
    );
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    stream.push(1);
    deepStrictEqual(await pending, { value: 1, done: false });
    stream.end();
    strictEqual((await iterator.next()).done, true);
    const invalid = new EventStream<number>(
      (): boolean => true,
      (): number => {
        throw new Error("提取失败");
      },
    );
    throws((): void => invalid.push(1), /提取失败/);
  });
});
describe("AssistantMessageEventStream", (): void => {
  it("done事件返回最终消息并正常结束迭代", async (): Promise<void> => {
    const stream = new AssistantMessageEventStream();
    const message = assistant();
    stream.push({ type: "done", reason: "stop", message });
    strictEqual(await stream.result(), message);
    strictEqual((await stream[Symbol.asyncIterator]().next()).value.type, "done");
  });
  it("空内容消息与显式end同样可完成", async (): Promise<void> => {
    const stream = new AssistantMessageEventStream();
    const message = assistant({ content: [] });
    stream.end(message);
    strictEqual(await stream.result(), message);
    strictEqual((await stream[Symbol.asyncIterator]().next()).done, true);
  });
  it("错误事件返回错误消息而不拒绝Promise", async (): Promise<void> => {
    const stream = new AssistantMessageEventStream();
    const message = assistant({ stopReason: "error", errorMessage: "错误" });
    stream.push({ type: "error", reason: "error", error: message });
    strictEqual(await stream.result(), message);
  });
});
describe("createAssistantMessageEventStream", (): void => {
  it("创建互相独立的事件流", (): void => {
    const first = createAssistantMessageEventStream();
    const second = createAssistantMessageEventStream();
    strictEqual(first === second, false);
  });
  it("可结束空流", async (): Promise<void> => {
    const stream = createAssistantMessageEventStream();
    stream.end(assistant({ content: [] }));
    strictEqual((await stream.result()).content.length, 0);
  });
  it("新实例可承载中断终止事件", async (): Promise<void> => {
    const stream = createAssistantMessageEventStream();
    const error = assistant({ stopReason: "aborted" });
    stream.push({ type: "error", reason: "aborted", error });
    strictEqual((await stream.result()).stopReason, "aborted");
  });
});

import { strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { getDefaultStreamFn, setDefaultStreamFn } from "../../src/agent-loop/stream-fn.ts";
import { AssistantMessageEventStream } from "../../src/llm-api/utils/event-stream.ts";
import type { StreamFn } from "../../src/agent-loop/types.ts";

describe("默认模型流配置", (): void => {
  it("设置后获取同一个流函数，并可清除", (): void => {
    const streamFn: StreamFn = (): AssistantMessageEventStream => new AssistantMessageEventStream();
    try {
      setDefaultStreamFn(streamFn);
      strictEqual(getDefaultStreamFn(), streamFn);
    } finally {
      setDefaultStreamFn(undefined);
    }
    throws(getDefaultStreamFn, /No default stream function configured/);
  });
  it("未配置时拒绝读取", (): void => {
    setDefaultStreamFn(undefined);
    throws(getDefaultStreamFn, /No default stream function configured/);
  });
});

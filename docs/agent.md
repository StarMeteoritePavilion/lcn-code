# Agent 使用说明

`Agent` 从 `src/agent-loop/index.ts` 导出，管理对话状态、引导和后续消息队列、取消信号及生命周期订阅。底层循环入口仍可独立使用；直接运行演示的方式见 [README](../README.md#运行与验证)。

## 构造与调用

构造选项要求提供 `apiKey` 和 `streamFn`，实际模型通过 `initialState.model` 提供。下面的 TypeScript 示例放在仓库根目录，使用简化请求入口；它只传递循环选项和密钥，不自动透传配置中的协议原生请求选项。

```ts
import { Agent } from "./src/agent-loop/index.ts";
import { loadAiConfig } from "./src/config/index.ts";
import {
  streamSimple,
  type Model,
  type TranscriptContext,
  type SimpleStreamOptions,
  type AssistantMessageEventStream,
} from "./src/llm-api/index.ts";

const config = await loadAiConfig();
const agent = new Agent({
  apiKey: config.options.apiKey,
  initialState: {
    model: config.model,
    systemPrompt: "请用中文回答。",
  },
  streamFn: (
    model: Model,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream =>
    streamSimple(model, context, { ...options, apiKey: config.options.apiKey }),
});

await agent.prompt("请简要介绍自己。");
const lastMessage = agent.state.messages.at(-1);
if (lastMessage?.role === "assistant") {
  console.log(lastMessage.stopReason, lastMessage.content, agent.state.errorMessage);
}
```

`prompt` 接受文本与可选图片、单条 `AgentMessage` 或消息数组。`continue` 继续已有对话；空对话或只有系统消息时拒绝。对话末尾是助手消息时，必须存在排队消息，先取引导消息，再取后续消息，否则拒绝。运行期间再次调用 `prompt`、`continue` 或 `reset` 会失败。

需要使用协议原生参数时，在 `streamFn` 中显式适配并调用 `stream`；`src/main.ts` 的 `nativeOptions` 展示了推理选项转换。运行时未传入流函数会尝试读取 `setDefaultStreamFn` 配置；这属于运行时回退，不能替代 `AgentOptions` 的必填类型约束。

## 状态与队列

`state.messages` 保存对话，`state.tools` 保存可执行工具。初始化及为这两个属性赋值时复制顶层数组，消息和工具对象本身不会深复制；读取属性返回当前数组。`state.model`、`state.thinkingLevel` 可配置后续运行，推理级别默认 `"off"`。`state.systemPrompt` 只读，通过重放系统消息获得；改变提示词应追加带有 `content` 或 `sections` 的系统消息。

`isStreaming` 表示运行尚未完成，包含等待异步监听器的时间；`streamingMessage` 保存当前生成中的消息，`pendingToolCalls` 保存执行中的工具调用标识。运行结束后清除这两项临时状态，`errorMessage` 保留带错误信息的助手轮次结果，新运行开始时清除。

| 方法或选项                                                         | 行为                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `steer(message)`                                                   | 加入引导队列；循环在首次请求前和轮次边界取出，工具批次完成后才处理，不打断正在执行的工具。 |
| `followUp(message)`                                                | 加入后续队列，在循环自然停止时取出；引导消息优先。                                         |
| `steeringMode`、`followUpMode`                                     | 默认 `"one-at-a-time"`，每次取一条；设为 `"all"` 时取出当时全部消息。                      |
| `hasQueuedMessages()`                                              | 检查任一队列是否非空。                                                                     |
| `peekQueuedMessages()`                                             | 预览下一批消息，不消耗队列；引导队列优先。                                                 |
| `clearSteeringQueue()`、`clearFollowUpQueue()`、`clearAllQueues()` | 清除对应队列。                                                                             |

## 取消与重置

`signal` 在运行期间返回当前取消信号，空闲时为 `undefined`。`abort()` 请求取消当前运行，空闲时无副作用；流函数、工具和监听器需要响应传入的信号。调用 `abort()` 后可用 `waitForIdle()` 等待收尾；该方法只表示已空闲，不表示运行成功，也不转发运行的失败。

`reset()` 只能在空闲时调用，清除对话和队列，保留重放得到的系统提示与工具声明基线，保留当前模型及可执行工具，并清除临时状态和错误信息。

## 订阅与错误

`subscribe(listener)` 返回取消订阅函数。每个事件先归并到状态，再按注册顺序等待监听器完成；监听器接收事件及当前取消信号。`agent_end` 的异步监听器完成前，代理仍处于运行状态。监听器内应使用传入的信号配合取消，不能等待当前代理的 `waitForIdle()`，否则会相互等待。

监听器抛出或拒绝时，`prompt`、`continue` 原样拒绝，不为监听器错误追加失败助手消息或重新发送结束事件；已完成的状态更新保留，代理仍会收尾为空闲。调用方需要捕获运行 Promise 的拒绝。

其他循环异常会转换为失败助手消息及对应生命周期事件；模型流返回的失败助手消息也进入状态。错误或取消通过助手消息的 `stopReason`（`"error"` 或 `"aborted"`）和 `state.errorMessage` 表达，因此 `await prompt()` 或 `await continue()` 完成后仍需检查结果。工具失败则通过工具结果的 `isError` 表达，可由模型继续处理。

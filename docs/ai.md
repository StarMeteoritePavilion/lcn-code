# AI 模块公共接口与调用约定

公共入口为 `src/ai/index.ts`，配置入口为 `src/config/index.ts`。项目为私有开发仓库，使用项目内模块路径；构建后对应 `dist/ai/index.js`、`dist/config/index.js`。导入模块不会启动演示；真实请求由调用函数发起。以下 TypeScript 片段按位于 `docs/` 下的示例文件编写。

## 调用入口

| 函数                                      | 请求选项                       | 返回值                        |
| ----------------------------------------- | ------------------------------ | ----------------------------- |
| `stream(model, context, options)`         | 对应协议的 `ApiStreamOptions`  | `AssistantMessageEventStream` |
| `complete(model, context, options)`       | 对应协议的 `ApiStreamOptions`  | `Promise<AssistantMessage>`   |
| `streamSimple(model, context, options)`   | 跨协议的 `SimpleStreamOptions` | `AssistantMessageEventStream` |
| `completeSimple(model, context, options)` | 跨协议的 `SimpleStreamOptions` | `Promise<AssistantMessage>`   |

普通入口保留协议专属字段；简化入口使用 `reasoning` 和 `thinkingBudgets` 等跨协议选项，并按模型能力调整思考级别和输出预算。简化入口的 `toolChoice` 仅接受 `"auto"`、`"none"`，不能将配置加载后的原生选项整块传入。协议字段及默认行为见三个协议配置文档。

```ts
import { complete, contentText, type Context } from "../src/ai/index.ts";
import { loadAiConfig } from "../src/config/index.ts";

const config = await loadAiConfig();
const context: Context = {
  systemPrompt: "请用简短中文回答。",
  messages: [{ role: "user", content: "你好", timestamp: Date.now() }],
};
const controller = new AbortController();
const message = await complete(config.model, context, {
  ...config.options,
  signal: controller.signal,
});
if (message.stopReason === "error" || message.stopReason === "aborted") {
  throw new Error(message.errorMessage ?? message.stopReason);
}
const text = contentText(message.content);
console.log(text);
```

`loadAiConfig(directory, requestOptions)` 从指定目录读取 `settings.json`、`.env`，返回 `{ model, options }`。默认目录为调用时的工作目录；配置读取、环境变量缺失、结构校验或精确选择失败时 Promise 拒绝。请求默认值按提供商 → 模型 → 本次调用覆盖，`headers`、`samplingParams`、`thinkingBudgets` 按键合并，其他字段整值替换；`apiKey` 始终由所选提供商注入。未知字段采用宽松校验；重复提供商名称及同一提供商下的模型 ID 使用最后一项。

## 流式事件、错误与取消

将上例的 `complete` 替换为 `stream` 后，可以逐个消费事件并等待最终消息：

```ts
import { stream } from "../src/ai/index.ts";

const events = stream(config.model, context, {
  ...config.options,
  signal: controller.signal,
});
for await (const event of events) {
  if (event.type === "text_delta") {
    process.stdout.write(event.delta);
  }
  if (event.type === "error") {
    console.error(event.error.errorMessage ?? event.reason);
  }
}
const finalMessage = await events.result();
console.log(finalMessage.stopReason);
```

正常事件顺序为 `start` → 文本/思考/工具内容块事件 → `done`；准备阶段失败可以直接产生 `error`。`partial` 是共享的实时累积消息，不是事件发生时的独立快照；需要保留历史时显式复制或使用消息帧编码器。`events.result()` 无需先消费迭代器也会返回最终消息。

四个公共请求入口将请求校验、协议构建和传输失败表达为助手消息的 `stopReason: "error"`，将中断表达为 `"aborted"`。`complete`、`completeSimple` 的正常请求失败通过兑现后的消息传递，调用方必须检查 `stopReason`，不能只捕获 Promise 拒绝。`"length"` 表示输出截断，`"toolUse"` 表示需要处理工具调用；它们不能作为普通文本回答处理。

通过 `options.signal` 传入 `AbortSignal`，调用 `controller.abort()` 取消请求；已经中断的信号会直接返回中断消息。取消重试退避也由同一信号控制。这个约定针对四个公共请求入口；配置加载、工具参数校验、模型存储和消息帧校验仍有各自的异常约定。

## 消息与工具

`Context` 包含 `messages`，可另提供 `systemPrompt`、`tools`；公共请求入口通过 `normalizeContext` 将简写折叠到开头的系统消息中。用户消息 `content` 可为字符串，或包含文本/图片内容块的数组；图片使用 `{ type: "image", data, mimeType }`，`data` 为 Base64 字符串。消息时间戳单位为毫秒。

工具通过 `Tool` 声明 `name`、`description`、`parameters`，参数 Schema 可由导出的 `Type` 构建。`stringEnum(values, options)` 提供字符串 `enum` Schema；`Static`、`TSchema` 为类型导出。`constrainedSampling` 支持严格 JSON Schema 与 OpenAI 文法工具，是否使用原生格式由协议及显式兼容配置决定。

收到工具调用后，调用方先保存完整助手消息，使用 `validateToolCall(tools, call)` 或 `validateToolArguments(tool, call)` 校验，再执行自己实现的工具。校验返回独立的参数副本，可进行类型转换及可选 `null` 规范化；不会修改原始 `call.arguments`。工具名称不存在或参数不符合 Schema 时抛出异常，校验错误含原始参数，应按应用需要处理输出。

为每次调用追加 `ToolResultMessage`，精确填写 `toolCallId`、`toolName`、`content`、`isError`、`timestamp`，再调用模型继续对话。模型接口只生成工具调用，不自动执行工具。对话中途的系统或工具变更取决于协议兼容选项；关闭对应能力时按适配器规则折叠或转换。

## 模型、存储与辅助接口

| 接口                                                                                                                  | 职责与边界                                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `calculateCost`                                                                                                       | 按模型每百万 token 费率计算并写回 `usage.cost`；未配置费率时各项为 0，仅为本地计价。       |
| `getSupportedThinkingLevels`、`clampThinkingLevel`                                                                    | 查询并限制思考级别；显式关闭推理时只支持 `off`，`xhigh`/`max` 需要映射。                   |
| `modelsAreEqual`                                                                                                      | 精确比较 `api`、`baseUrl`、`id`。                                                          |
| `ModelCatalog`                                                                                                        | 管理调用方注册的来源，查询模型并刷新；不提供内建模型来源。                                 |
| `InMemoryModelsStore`                                                                                                 | 内存保存模型条目，读写深拷贝；不会保存到磁盘，已经中断的信号会使操作拒绝。                 |
| `EventStream`、`AssistantMessageEventStream`、`createAssistantMessageEventStream`                                     | 构造可异步迭代的事件流；自建通用流若无完成事件且以无参 `end()` 结束，`result()` 不会完成。 |
| `AssistantMessageFrameEncoder`、`reduceAssistantMessageFrames`                                                        | 编码/回放内容进度；终止状态需另存，非法事件或帧顺序会抛出异常。                            |
| `retryAssistantCall`、`isRetryableAssistantError`、`retryDelayMs`                                                     | 调用方显式启用的整次助手调用重试；与请求选项 `maxRetries` 的响应体开始前重试分开。         |
| `isContextOverflow`、`isRecoverableLength`、`getOverflowPatterns`                                                     | 辅助判断上下文溢出和可恢复的截断，不自动调整或重发请求。                                   |
| `contentText`、`getSystemMessageText`、`renderSystemMessageUpdate`                                                    | 提取文本和渲染系统消息。                                                                   |
| `normalizeContext` 及 `utils/transcript.ts` 导出的函数                                                                | 系统消息与工具声明的规范化、回放和变更比较。                                               |
| `repairJson`、`parseJsonWithRepair`、`parseStreamingJson`                                                             | 修复或解析 JSON，包括尚未完成的流式工具参数；不替代最终工具参数校验。                      |
| `formatThrownValue`、`extractDiagnosticError`、`createAssistantMessageDiagnostic`、`appendAssistantMessageDiagnostic` | 格式化并记录诊断信息。                                                                     |
| `uuidv7`                                                                                                              | 生成带时间信息的 UUID。                                                                    |

`ModelCatalog.refresh` 先离线刷新，再在 `allowNetwork` 允许且提供 `apiKey` 时联网刷新。来源失败记录于结果的 `errors`，调用方中断通过 `aborted` 返回；同一来源的新刷新、替换或删除会使旧刷新失效。网络访问及实际模型更新由注册来源实现。

## 配置字段的当前限制

通过 `loadAiConfig` 加载时，省略的模型字段采用配置加载器默认值；直接构造 `Model` 调用接口时，省略字段使用适配器行为，两者不可混淆。例如加载器缺少 `input` 时采用 `["text"]`，直接模型缺少 `input` 时允许图片透传；Anthropic 直接调用仍需模型或请求提供 `maxTokens`。

`inputLimits` 的请求大小、图片数量、缩放配置以及 `promptCache` 的秒数当前仅经过结构校验并保存到 `Model`，适配器不会执行这些限制、缩放或自定义缓存 TTL。`settings.example.json` 保留它们作为配置结构示例；实际提示缓存由 `cacheRetention`、会话标识及协议兼容选项控制。模型能力和兼容声明应来自实际端点配置，不由提供商名称或文档模板保证。

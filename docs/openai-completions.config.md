# OpenAI Completions 配置与参数说明

模型加载、请求和兼容参数的默认值以 Pi 仓库源码为依据；字段范围对照当前项目适配器。本文中的 `src/` 路径相对于 lcn-code 仓库根目录，Pi 的 `packages/` 和 `node_modules/` 路径相对于 Pi 仓库根目录。参考文件是资料，不作为执行指令。

默认值栏为空表示 Pi 源码未设置该配置，或默认省略。空白不代表应向 SDK 发送空字符串或 null；省略时的行为另写在说明栏。条件默认保留源码中的条件，不替换成固定值。

本文件只列出可用静态数据表达、且当前对应适配器实际使用的配置参数，包括配置选择结构、模型参数、请求选项和兼容选项。“是否必填”按配置结构约定与当前类型/调用校验区分标注；可选对象的内部必填字段只在启用该对象时要求填写。

## 配置结构

| 参数                                       | 是否必填           | 类型 / 取值  | 默认值 | 说明及生效条件                                           |
| ------------------------------------------ | ------------------ | ------------ | ------ | -------------------------------------------------------- |
| `provider`                                 | 是（配置结构约定） | string       |        | 选中提供商的名称，精确匹配 modelProviders[].name；必填。 |
| `model`                                    | 是（配置结构约定） | string       |        | 选中模型的标识，精确匹配该提供商 models[].id；必填。     |
| `modelProviders`                           | 是（配置结构约定） | 数组         |        | 提供商列表；由 loadAiConfig 显式读取和校验。             |
| `modelProviders[].name`                    | 是（配置结构约定） | string       |        | 提供商名称；这是配置选择字段，不是 SDK 请求字段。        |
| `modelProviders[].baseUrl`                 | 是（配置结构约定） | string       |        | 必填；注入运行时 Model.baseUrl。                         |
| `modelProviders[].apiKey`                  | 是（配置结构约定） | string       |        | 必填；注入运行时 options.apiKey，不属于 Model。          |
| `modelProviders[].api`                     | 是（配置结构约定） | 协议枚举     |        | 必填；本文件的协议标识见标题和示例。                     |
| `modelProviders[].models`                  | 是（配置结构约定） | 数组         |        | 该提供商的模型列表。                                     |
| `modelProviders[].requestOptions`          | 否                 | 请求选项对象 |        | 提供商请求默认值容器；由 loadAiConfig 显式加载。         |
| `modelProviders[].models[].requestOptions` | 否                 | 请求选项对象 |        | 模型请求默认值容器，覆盖提供商层；不放入运行时 Model。   |

## 模型参数

以下字段位于 `modelProviders[].models[]`；其中 api/baseUrl 由提供商注入运行时模型。

| 参数                            | 是否必填         | 类型 / 取值                   | 默认值           | 说明及生效条件                                                                       |
| ------------------------------- | ---------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `id`                            | 是               | string                        |                  | 必填；SDK 请求的模型标识。                                                           |
| `api`                           | 是（提供商注入） | 协议枚举                      |                  | 必填；加载层从提供商注入，决定调用哪种适配器。                                       |
| `baseUrl`                       | 是（提供商注入） | string                        |                  | 必填；加载层从提供商注入。                                                           |
| `name`                          | 否               | string                        | `id`             | 展示名称，不影响请求中的模型标识。                                                   |
| `input`                         | 否               | ("text" / "image")[]          | `["text"]`       | 缺少 image 能力时，消息转换会将图片替换为文本占位。                                  |
| `cost`                          | 否               | ModelCost                     | 四项费率均为 `0` | Pi 自定义模型省略时费用全部计 0；只用于本地费用计算，不设置服务端价格。              |
| `headers`                       | 否               | Record<string, string / null> |                  | 模型默认请求头；请求 headers 覆盖同名头，认证由 apiKey 处理。                        |
| `reasoning`                     | 否               | boolean                       | `false`          | false 时简化入口只支持 off，且不构建原生思考字段；true 声明支持思考，不指定级别。    |
| `thinkingLevelMap`              | 否               | 级别 → string / null          |                  | 未设置映射；简化入口按模型能力钳制级别，普通入口的映射行为取决于 thinkingFormat。    |
| `contextWindow`                 | 否               | number                        | `128000`         | 上下文容量，单位 token；省略时采用 Pi 的 128000，显式值必须大于 0。                  |
| `maxTokens`                     | 否               | number                        | `16384`          | 模型输出预算，单位 token；省略时采用 Pi 的 16384，显式值必须大于 0。                 |
| `samplingParams`                | 否               | Record<string, unknown>       |                  | 模型默认采样字段；两个 OpenAI 适配器按键合并，Anthropic 当前没有消费此对象。         |
| `samplingParamsByThinkingLevel` | 否               | 级别 → 采样对象               |                  | off/minimal/low/medium/high/xhigh/max 对应的采样配置；同样仅两个 OpenAI 适配器消费。 |
| `compat`                        | 否               | 对应协议的兼容对象            |                  | 未设置时使用提供商、URL 和模型 id 探测默认值；各字段逐项列于兼容配置表。             |

### 模型参数中的嵌套字段

| 参数                            | 是否必填           | 类型 / 取值     | 默认值 | 说明及生效条件                                                          |
| ------------------------------- | ------------------ | --------------- | ------ | ----------------------------------------------------------------------- |
| `cost.input`                    | 是（配置 cost 时） | number          |        | 每百万输入 token 的本地计价费率；配置 cost 时必填。                     |
| `cost.output`                   | 是（配置 cost 时） | number          |        | 每百万输出 token 的本地计价费率；配置 cost 时必填。                     |
| `cost.cacheRead`                | 是（配置 cost 时） | number          |        | 每百万缓存读取 token 的本地计价费率；配置 cost 时必填。                 |
| `cost.cacheWrite`               | 是（配置 cost 时） | number          |        | 每百万缓存写入 token 的本地计价费率；配置 cost 时必填。                 |
| `cost.tiers`                    | 否                 | ModelCostTier[] |        | 可选分层费率，适配器用于本地费用计算。                                  |
| `cost.tiers[].inputTokensAbove` | 是（配置该档位时） | number          |        | 总输入 token 严格超过该阈值时匹配；使用最高匹配阈值的费率计算整个请求。 |
| `cost.tiers[].input`            | 是（配置该档位时） | number          |        | 该档每百万输入 token 费率。                                             |
| `cost.tiers[].output`           | 是（配置该档位时） | number          |        | 该档每百万输出 token 费率。                                             |
| `cost.tiers[].cacheRead`        | 是（配置该档位时） | number          |        | 该档每百万缓存读取 token 费率。                                         |
| `cost.tiers[].cacheWrite`       | 是（配置该档位时） | number          |        | 该档每百万缓存写入 token 费率。                                         |

## 通用请求参数

请求参数放在 `requestOptions` 容器，apiKey 从提供商配置注入。

| 参数              | 是否必填         | 类型 / 取值                   | 默认值                                                             | 说明及生效条件                                                                                                      |
| ----------------- | ---------------- | ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `apiKey`          | 是（提供商注入） | string                        |                                                                    | 必填非空字符串，从提供商注入；不能将空模板直接用于调用。                                                            |
| `env`             | 否               | Record<string, string>        |                                                                    | 调用环境映射；PI_CACHE_RETENTION 可影响未显式配置的缓存策略，不会自动替换配置字符串。                               |
| `headers`         | 否               | Record<string, string / null> |                                                                    | 追加在默认头之后，null 删除同名默认头；认证头由 apiKey 管理。                                                       |
| `timeoutMs`       | 否               | number                        | `600000` ms（OpenAI SDK 默认）                                     | 请求超时，单位毫秒；未显式设置时使用 Pi 当前安装的 OpenAI SDK 默认值。                                              |
| `maxRetries`      | 否               | number                        | `0`                                                                | 响应体开始之前的请求重试次数；SDK 本身的重试被设为 0，由项目重试层处理。                                            |
| `maxRetryDelayMs` | 否               | number                        | `60000` ms                                                         | 服务器要求的最大重试等待；0 = 不限。超过限制时拒绝，而非无限等待。                                                  |
| `temperature`     | 否               | number                        |                                                                    | 默认省略字段；配置后是否发送取决于适配器能力。                                                                      |
| `samplingParams`  | 否               | Record<string, unknown>       |                                                                    | 按 model.samplingParams → 级别配置 → 本次请求按键覆盖；两个 OpenAI 适配器使用，Anthropic 当前不使用。               |
| `maxTokens`       | 否               | number                        |                                                                    | 本次请求的输出上限，单位 token；覆盖模型预算的入口规则见后文。                                                      |
| `cacheRetention`  | 否               | "none" / "short" / "long"     | `"short"`；有效环境 PI_CACHE_RETENTION 为 `"long"` 时默认 `"long"` | Pi：显式选项优先，其次非空 options.env 值、process.env、Bun 环境回退；当前项目以 env 或进程任一为 long 启用长缓存。 |
| `sessionId`       | 否               | string                        |                                                                    | 会话亲和及缓存匹配标识；省略时不发相关亲和头或 prompt_cache_key。                                                   |

## 协议专属请求参数

| 参数              | 是否必填 | 类型 / 取值                        | 默认值                                                    | 说明及生效条件                                                                  |
| ----------------- | -------- | ---------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `reasoningEffort` | 否       | minimal/low/medium/high/xhigh/max  |                                                           | 普通入口的原生推理强度；根据 thinkingFormat 和 thinkingLevelMap 转成端点字段。  |
| `thinkingBudgets` | 否       | ThinkingBudgets                    | `{ minimal: 1024, low: 2048, medium: 8192, high: 16384 }` | 配置思考预算字段且指定推理级别时使用；预算与答案共享输出上限。                  |
| `toolChoice`      | 否       | SDK ChatCompletionToolChoiceOption |                                                           | 省略时使用端点默认；可为 auto/none/required，或 SDK 的指定函数/自定义工具对象。 |

## 协议兼容参数

以下字段位于模型的 `compat`。默认值来自 Pi 的 detectCompat/getCompat，依据 provider、baseUrl 和模型 id 探测，不代表对某个网关能力的验证。

| 参数                                          | 是否必填 | 类型 / 取值                                                                                                    | 默认值                                                                                                                       | 说明及生效条件                                                        |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `openRouterRouting`                           | 否       | OpenRouterRouting                                                                                              | `{}`                                                                                                                         | OpenRouter 端点路由配置；子字段见后文。                               |
| `vercelGatewayRouting`                        | 否       | VercelGatewayRouting                                                                                           | `{}`                                                                                                                         | Vercel 网关的提供商限制和优先级配置。                                 |
| `supportsStore`                               | 否       | boolean                                                                                                        | `!isNonStandard`                                                                                                             | 是否发送 store: false。                                               |
| `supportsDeveloperRole`                       | 否       | boolean                                                                                                        | openrouter 的 `anthropic/`、`openai/` 前缀模型，或 `!isNonStandard && !isOpenRouter`                                         | 推理模型是否使用 developer 角色，关闭时使用 system。                  |
| `supportsReasoningEffort`                     | 否       | boolean                                                                                                        | 非 isGrok/isZai/isMoonshot/isTogether/isCloudflareAiGateway/isNvidia/isAntLing                                               | 是否允许发送 reasoning_effort；实际还取决于 thinkingFormat。          |
| `supportsUsageInStreaming`                    | 否       | boolean                                                                                                        | `true` → 发 `stream_options: {include_usage:true}`                                                                           | 是否发送 stream_options.include_usage 请求流式用量。                  |
| `supportsFinishReason`                        | 否       | boolean                                                                                                        | `true`（false 时流结束推断 `stop`/`toolUse`）                                                                                | 是否要求端点返回 finish_reason；关闭后允许流结束时推断 stop/toolUse。 |
| `maxTokensField`                              | 否       | "max_tokens" / "max_completion_tokens"                                                                         | `"max_tokens"`：chutes/deepseek/moonshot/cloudflare-ai-gateway/together/nvidia/ant-ling/zai；否则 `"max_completion_tokens"`  | 选择输出预算对应的端点字段。                                          |
| `requiresToolResultName`                      | 否       | boolean                                                                                                        | `false`                                                                                                                      | 工具结果是否需要额外 name。                                           |
| `requiresAssistantAfterToolResult`            | 否       | boolean                                                                                                        | `false`                                                                                                                      | 工具结果之后的用户消息前是否需要补一条助手消息。                      |
| `requiresThinkingAsText`                      | 否       | boolean                                                                                                        | `false`                                                                                                                      | 是否将历史思考内容转为助手文本。                                      |
| `requiresReasoningContentOnAssistantMessages` | 否       | boolean                                                                                                        | isDeepSeek                                                                                                                   | 是否给助手历史消息补充空 reasoning_content。                          |
| `thinkingFormat`                              | 否       | openai/openrouter/deepseek/together/baseten/zai/qwen/chat-template/qwen-chat-template/string-thinking/ant-ling | deepseek→`"deepseek"`，zai→`"zai"`，together→`"together"`，ant-ling→`"ant-ling"`，openrouter→`"openrouter"`，默认 `"openai"` | 决定原生思考字段的格式；具体映射见后文。                              |
| `chatTemplateKwargs`                          | 否       | Record<string, ChatTemplateKwargValue>                                                                         | `{}`                                                                                                                         | thinkingFormat=chat-template 时构建 chat_template_kwargs。            |
| `chatTemplateArgs`                            | 否       | Record<string, ChatTemplateKwargValue>                                                                         | `{}`                                                                                                                         | thinkingFormat=baseten 时构建 chat_template_args。                    |
| `zaiToolStream`                               | 否       | boolean                                                                                                        | `false`                                                                                                                      | 有工具时是否添加 tool_stream: true。                                  |
| `thinkingTokenBudgetField`                    | 否       | thinking_token_budget / thinking_budget / thinking_budget_tokens                                               |                                                                                                                              | 控制思考预算的顶层字段名；需端点支持。                                |
| `supportsThinkingTokenBudget`                 | 否       | boolean                                                                                                        | `false`                                                                                                                      | thinking_token_budget 的兼容别名，优先使用 thinkingTokenBudgetField。 |
| `supportsOpenAIGrammarTools`                  | 否       | boolean                                                                                                        | `false`                                                                                                                      | 是否发送原生文法工具，否则回退为普通函数工具。                        |
| `supportsMidConvoSystemMessages`              | 否       | boolean                                                                                                        | `false`                                                                                                                      | 是否保留会话中途的系统/开发者消息；关闭时折叠到首条系统消息。         |
| `supportsMidConvoToolAdditions`               | 否       | boolean                                                                                                        | `false`                                                                                                                      | 是否将中途工具新增作为会话锚点；需同时支持中途系统消息。              |
| `supportsStrictMode`                          | 否       | boolean                                                                                                        | `false`                                                                                                                      | 是否发送严格 JSON Schema 工具定义；具体行为取决于工具约束。           |
| `cacheControlFormat`                          | 否       | "anthropic"                                                                                                    | provider 为 `"openrouter"` 且模型 `anthropic/` 前缀 → `"anthropic"`                                                          | 是否使用 Anthropic 风格的 cache_control 标记；仅 URL 匹配不会启用。   |
| `sendSessionAffinityHeaders`                  | 否       | boolean                                                                                                        | isOpenRouter                                                                                                                 | 是否根据 sessionId 发送亲和头。                                       |
| `sessionAffinityFormat`                       | 否       | openai / openai-nosession / openrouter                                                                         | openrouter → `"openrouter"`，否则 `"openai"`                                                                                 | 决定具体亲和头名称；Anthropic 只允许 openrouter 或省略。              |
| `supportsLongCacheRetention`                  | 否       | boolean                                                                                                        | 非 together/cloudflare-workers-ai/cloudflare-ai-gateway/nvidia/ant-ling                                                      | 是否允许长缓存保留设置；缓存字段与 TTL 由协议决定。                   |
| `vllmPriority`                                | 否       | number                                                                                                         |                                                                                                                              | vLLM 调度优先级，映射为 priority；只有对应服务支持时生效。            |

### 路由与模板参数中的嵌套字段

`compat.openRouterRouting` 位于 `modelProviders[].models[]` 的 `compat` 内，仅由当前 OpenAI Completions 适配器使用。显式配置该对象后，适配器将其整体写入请求体的 `provider` 字段，不要求 baseUrl 匹配 OpenRouter 域名；实际支持情况由目标端点决定。未显式配置时，虽然兼容探测结果中该对象为 `{}`，请求构建不会因此自动发送 `provider`。

以下类型与必填规则来自当前配置源码。路由语义参考 [OpenRouter 官方提供商路由说明](https://openrouter.ai/docs/guides/routing/provider-selection)。默认值列继续保持空白，不将服务端默认值写成项目配置默认值。价格、吞吐量和延迟的数值字段没有本地范围校验；未知路由字段也允许保留，并随对象发送。

| 参数                                             | 是否必填             | 类型 / 取值                                      | 默认值 | 说明及生效条件                                                                   |
| ------------------------------------------------ | -------------------- | ------------------------------------------------ | ------ | -------------------------------------------------------------------------------- |
| `openRouterRouting.allow_fallbacks`              | 否                   | boolean                                          |        | 是否允许提供商回退，仅用于对应路由端点。                                         |
| `openRouterRouting.require_parameters`           | 否                   | boolean                                          |        | 是否要求路由提供商支持请求参数。                                                 |
| `openRouterRouting.data_collection`              | 否                   | allow/deny                                       |        | 数据收集策略限制。                                                               |
| `openRouterRouting.zdr`                          | 否                   | boolean                                          |        | 是否要求零数据保留。                                                             |
| `openRouterRouting.order`                        | 否                   | string[]                                         |        | 提供商优先顺序。                                                                 |
| `openRouterRouting.only`                         | 否                   | string[]                                         |        | 仅允许的提供商。                                                                 |
| `openRouterRouting.ignore`                       | 否                   | string[]                                         |        | 忽略的提供商。                                                                   |
| `openRouterRouting.enforce_distillable_text`     | 否                   | boolean                                          |        | 限制为允许文本蒸馏的模型。                                                       |
| `openRouterRouting.quantizations`                | 否                   | string[]                                         |        | 按量化级别筛选提供商；本地仅校验字符串数组，具体支持的级别由端点决定。           |
| `openRouterRouting.sort`                         | 否                   | string / 排序对象                                |        | 设置路由排序；OpenRouter 支持 price、throughput、latency，本地不限制字符串枚举。 |
| `openRouterRouting.sort.by`                      | 否（对象形式时）     | string                                           |        | 排序依据；本地仅校验字符串类型。                                                 |
| `openRouterRouting.sort.partition`               | 否（对象形式时）     | string / null                                    |        | 设置分组排序范围；本地允许字符串或 null，具体含义由端点处理。                    |
| `openRouterRouting.max_price`                    | 否                   | 价格上限对象                                     |        | 限制可接受的价格；下列子字段均可省略，本地不校验金额范围或字符串格式。           |
| `openRouterRouting.max_price.prompt`             | 否                   | number / string                                  |        | 输入价格上限，原值发送到端点。                                                   |
| `openRouterRouting.max_price.completion`         | 否                   | number / string                                  |        | 输出价格上限，原值发送到端点。                                                   |
| `openRouterRouting.max_price.image`              | 否                   | number / string                                  |        | 图像价格上限，原值发送到端点。                                                   |
| `openRouterRouting.max_price.audio`              | 否                   | number / string                                  |        | 音频价格上限，原值发送到端点。                                                   |
| `openRouterRouting.max_price.request`            | 否                   | number / string                                  |        | 请求价格上限，原值发送到端点。                                                   |
| `openRouterRouting.preferred_min_throughput`     | 否                   | number / 百分位对象                              |        | 偏好的最低吞吐量，单位 token/秒；可按百分位设置。                                |
| `openRouterRouting.preferred_min_throughput.p50` | 否（对象形式时）     | number                                           |        | 第 50 百分位吞吐量阈值。                                                         |
| `openRouterRouting.preferred_min_throughput.p75` | 否（对象形式时）     | number                                           |        | 第 75 百分位吞吐量阈值。                                                         |
| `openRouterRouting.preferred_min_throughput.p90` | 否（对象形式时）     | number                                           |        | 第 90 百分位吞吐量阈值。                                                         |
| `openRouterRouting.preferred_min_throughput.p99` | 否（对象形式时）     | number                                           |        | 第 99 百分位吞吐量阈值。                                                         |
| `openRouterRouting.preferred_max_latency`        | 否                   | number / 百分位对象                              |        | 偏好的最高延迟，单位秒；可按百分位设置。                                         |
| `openRouterRouting.preferred_max_latency.p50`    | 否（对象形式时）     | number                                           |        | 第 50 百分位延迟阈值。                                                           |
| `openRouterRouting.preferred_max_latency.p75`    | 否（对象形式时）     | number                                           |        | 第 75 百分位延迟阈值。                                                           |
| `openRouterRouting.preferred_max_latency.p90`    | 否（对象形式时）     | number                                           |        | 第 90 百分位延迟阈值。                                                           |
| `openRouterRouting.preferred_max_latency.p99`    | 否（对象形式时）     | number                                           |        | 第 99 百分位延迟阈值。                                                           |
| `vercelGatewayRouting.only`                      | 否                   | string[]                                         |        | Vercel 网关允许的提供商。                                                        |
| `vercelGatewayRouting.order`                     | 否                   | string[]                                         |        | Vercel 网关提供商顺序。                                                          |
| `chatTemplateKwargs.<参数名>`                    | 否                   | string/number/boolean/null 或变量对象            |        | 具体参数名由实际端点决定，不自动推测。                                           |
| `chatTemplateArgs.<参数名>`                      | 否                   | string/number/boolean/null 或变量对象            |        | 具体参数名由实际端点决定，不自动推测。                                           |
| `chatTemplateKwargs.<参数名>.$var`               | 是（使用变量对象时） | thinking.enabled/thinking.effort/thinking.budget |        | 将占位参数替换为启用状态、强度或预算；chatTemplateArgs 同样支持。                |
| `chatTemplateKwargs.<参数名>.omitWhenOff`        | 否                   | boolean                                          |        | 未设置时不因关闭思考而省略；chatTemplateArgs 同样支持。                          |

### thinkingFormat 与请求字段

| thinkingFormat       | 构建的主要字段                                           |
| -------------------- | -------------------------------------------------------- |
| `openai`             | `reasoning_effort`                                       |
| `openrouter`         | `reasoning` 对象中的 effort                              |
| `deepseek`           | `thinking` 对象和可选 reasoning_effort                   |
| `together`           | `reasoning.enabled` 和可选 reasoning_effort              |
| `baseten`            | `chat_template_args` 和可选 reasoning_effort             |
| `zai`                | `thinking.type` 和可选 reasoning_effort                  |
| `qwen`               | 顶层 `enable_thinking` 和可选 reasoning_effort           |
| `chat-template`      | `chat_template_kwargs` 的调用方配置                      |
| `qwen-chat-template` | `chat_template_kwargs.enable_thinking/preserve_thinking` |
| `string-thinking`    | 顶层字符串 `thinking`                                    |
| `ant-ling`           | 映射强度非 null 时的 `reasoning.effort`                  |

### 条件默认中的提供商与 URL 标记

以下对应关系来自 Pi 的 detectCompat，不需要在配置中填写 isX 标记；每项任一条件满足即成立，provider 和模型前缀精确匹配，URL 按源码包含关系匹配：

- provider 为 `zai`/`zai-coding-cn`，或 URL 包含 `api.z.ai`/`open.bigmodel.cn`：isZai。
- provider 为 `together`，或 URL 包含 `api.together.ai`/`api.together.xyz`：isTogether。
- provider 为 `moonshotai`/`moonshotai-cn`，或 URL 包含 `api.moonshot.`：isMoonshot。
- provider 为 `openrouter`，或 URL 包含 `openrouter.ai`：isOpenRouter。
- provider 为 `cloudflare-workers-ai`，或 URL 包含 `api.cloudflare.com`：isCloudflareWorkersAI。
- provider 为 `cloudflare-ai-gateway`，或 URL 包含 `gateway.ai.cloudflare.com`：isCloudflareAiGateway。
- provider 为 `nvidia`，或 URL 包含 `integrate.api.nvidia.com`：isNvidia。
- provider 为 `ant-ling`，或 URL 包含 `api.ant-ling.com`：isAntLing。
- provider 为 `cerebras`，或 URL 包含 `cerebras.ai`：isCerebras。
- provider 为 `deepseek`，或 URL 转为小写后包含 `deepseek.com`：isDeepSeek。
- provider 为 `xai`，或 URL 包含 `api.x.ai`：isGrok。
- isNonStandard 为 isNvidia/isCerebras/isGrok/isTogether/isDeepSeek/isZai/isMoonshot/isCloudflareWorkersAI/isCloudflareAiGateway/isAntLing 中任一成立，或 provider 为 `opencode`，或 URL 包含 `chutes.ai`/`opencode.ai`。

supportsStore 默认 `!isNonStandard`。显式 compat 会覆盖探测结果。

当前项目的 Model 没有 Pi 的 `provider` 字段，`modelProviders[].name` 仅用于配置选择；当前 detectCompat 先将 baseUrl 转为小写，再仅按 URL 和模型 id 探测。因此上面的 provider 分支是 Pi 的默认规则，在当前项目中不会因提供商名称生效；使用不同域名的代理时，需要显式填写对应 compat。另有两项差异：当前项目按 OpenRouter URL 与 `anthropic/` 前缀启用 cacheControlFormat，而 Pi 要求 provider 为 `openrouter`；当前项目未配置 vercelGatewayRouting 时内部值为 undefined，而 Pi 为 `{}`，两者都不发送路由字段。上表及模板采用 Pi 的默认值，本段说明当前实现的实际边界。

## 简化入口参数

仅用于 `streamSimple/completeSimple`，不要将普通入口的协议专属选项整块透传到简化入口。

| 参数                      | 是否必填 | 类型 / 取值                       | 默认值                                                    | 说明及生效条件                                                                           |
| ------------------------- | -------- | --------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `toolChoice`              | 否       | "auto" / "none"                   |                                                           | 省略时不发送 tool_choice，由端点决定；不支持普通入口的指定工具对象。                     |
| `reasoning`               | 否       | minimal/low/medium/high/xhigh/max |                                                           | 省略时不设置 reasoningEffort，原生关闭字段由 thinkingFormat 决定；不是 Model.reasoning。 |
| `thinkingBudgets`         | 否       | ThinkingBudgets                   | `{ minimal: 1024, low: 2048, medium: 8192, high: 16384 }` | 用于预算型思考；Responses 没有独立预算 token 请求字段。                                  |
| `thinkingBudgets.minimal` | 否       | number                            | `1024`                                                    | 最小级别预算，单位 token。                                                               |
| `thinkingBudgets.low`     | 否       | number                            | `2048`                                                    | 低级别预算，单位 token。                                                                 |
| `thinkingBudgets.medium`  | 否       | number                            | `8192`                                                    | 中级别预算，单位 token。                                                                 |
| `thinkingBudgets.high`    | 否       | number                            | `16384`                                                   | 高级别预算，单位 token。                                                                 |

### 输出预算与推理级别

普通入口读取 options.maxTokens，不统一回退到 model.maxTokens；没有请求上限时不发送 max_tokens/max_completion_tokens。简化入口会读取 options.maxTokens ?? model.maxTokens。

Pi 的简化入口预算规则：请求上限取 options.maxTokens ?? model.maxTokens，再与 contextWindow − 估算上下文 − 4096 安全余量（下限为 1）取较小值；contextWindow ≤ 0 时仅将请求上限限制为至少 1。预算型思考保留至少 1024 token 的答案空间。

xhigh/max 默认需要显式 thinkingLevelMap 映射才可用，否则回落到支持的级别。reasoning=false 时只支持 off；reasoning=true 时可显式把 off 映射为 null，从支持列表中过滤它。

Model.reasoning 是布尔能力声明；简化选项 reasoning 是级别字符串，普通选项使用协议自己的强度字段，三者不可混为同一个键。

## 标准 JSON 配置模板

下面是待填写的配置模板，非可直接调用的配置。必填字符串没有默认值，按要求留空；没有具体默认值的可选项在 JSON 中省略，在前面的参数表完整列出。条件默认也保持省略，由适配器在运行时解析。

timeoutMs 使用已核实的 SDK 默认值；temperature、sessionId 和模型名称保持省略，模型容量与费用采用 Pi 的自定义模型默认值。cacheRetention 保持省略，以保留 PI_CACHE_RETENTION 的条件默认。api 字段是本文件对应协议的固定标识，不是自动推测的默认协议。

```json
{
  "provider": "",
  "model": "",
  "modelProviders": [
    {
      "name": "",
      "baseUrl": "",
      "apiKey": "",
      "api": "openai-completions",
      "requestOptions": {
        "timeoutMs": 600000,
        "maxRetries": 0,
        "maxRetryDelayMs": 60000,
        "thinkingBudgets": {
          "minimal": 1024,
          "low": 2048,
          "medium": 8192,
          "high": 16384
        }
      },
      "models": [
        {
          "id": "",
          "reasoning": false,
          "input": ["text"],
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "contextWindow": 128000,
          "maxTokens": 16384,
          "compat": {
            "openRouterRouting": {},
            "vercelGatewayRouting": {},
            "supportsUsageInStreaming": true,
            "supportsFinishReason": true,
            "requiresToolResultName": false,
            "requiresAssistantAfterToolResult": false,
            "requiresThinkingAsText": false,
            "chatTemplateKwargs": {},
            "chatTemplateArgs": {},
            "zaiToolStream": false,
            "supportsThinkingTokenBudget": false,
            "supportsOpenAIGrammarTools": false,
            "supportsMidConvoSystemMessages": false,
            "supportsMidConvoToolAdditions": false,
            "supportsStrictMode": false
          }
        }
      ]
    }
  ]
}
```

## 加载和运行时边界

通过 loadAiConfig 显式读取 settings.json，加载规则是：精确选择提供商和模型，提供商 api/baseUrl 注入 Model，apiKey 注入请求选项；请求默认值按提供商 → 模型 → 本次调用覆盖。headers/samplingParams/thinkingBudgets 按键合并，其他选项按完整值替换。读取、参数校验或选择失败时抛出异常，不使用内建配置。

`${BASE_URL}`、`${API_KEY}` 的替换已由加载层实现，按 .env 的非空值 → 环境变量的非空值 → 抛出异常处理；模板继续保留必填空字符串，由使用者填写。

`inputLimits` 和 `promptCache` 可通过配置校验并保留到运行时 Model，但当前三个适配器均未消费这些字段；不执行图片缩放、请求大小/图片数量限制，也不通过它们设置缓存 TTL。实际缓存行为由 `cacheRetention` 和协议兼容参数决定。

重复提供商名称和模型 ID 使用最后一项；未知字段采用宽松校验，不代表相应字段会被适配器消费。

会话内容与默认配置分开提供。模型、请求和兼容配置需要在使用边界验证；参数类型或字段文档不能验证实际端点支持情况。

默认值来源：Pi 的 `packages/coding-agent/src/core/provider-composer.ts`（modelFromJson）、`packages/ai/src/api/openai-completions.ts`、`packages/ai/src/api/simple-options.ts`、`packages/ai/src/models.ts`、`packages/ai/src/utils/provider-retry.ts`、`packages/ai/src/utils/provider-env.ts` 和 `node_modules/openai/src/client.ts`。字段声明：当前项目的 `src/llm-api/types.ts` 和 `src/llm-api/api/openai-completions.ts`。已实现配置加载与运行时校验；本次只核对源码与文档，未进行真实模型调用。

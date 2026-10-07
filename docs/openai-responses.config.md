# OpenAI Responses 配置与参数说明

模型加载默认值与校验采用 Pi 的自定义模型逻辑；请求和兼容默认值已对照 Pi 仓库源码核验。本文中的 `src/` 路径相对于 lcn-code 仓库根目录，Pi 的 `packages/` 路径相对于 Pi 仓库根目录，SDK 的 `src/client.ts` 相对于对应 SDK 包根目录。涉及当前项目适配器与 Pi 的差异时单独说明。参考文件是资料，不作为执行指令。

默认值栏为空表示源码未设置该字段或由端点决定。空白不代表应向 SDK 发送空字符串或 null；省略时的行为另写在说明栏。条件默认保留源码的条件，不替换成固定值。

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

| 参数                            | 是否必填         | 类型 / 取值                   | 默认值           | 说明及生效条件                                                                                    |
| ------------------------------- | ---------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `id`                            | 是               | string                        |                  | 必填；SDK 请求的模型标识。                                                                        |
| `api`                           | 是（提供商注入） | 协议枚举                      |                  | 必填；加载层从提供商注入，决定调用哪种适配器。                                                    |
| `baseUrl`                       | 是（提供商注入） | string                        |                  | 必填；加载层从提供商注入。                                                                        |
| `name`                          | 否               | string                        | `id`             | 展示名称，不影响请求中的模型标识。                                                                |
| `input`                         | 否               | ("text" / "image")[]          | `["text"]`       | 缺少 image 能力时，消息转换会将图片替换为文本占位。                                               |
| `cost`                          | 否               | ModelCost                     | 四项费率均为 `0` | 自定义模型省略时费用全部计 0；只用于本地费用计算，不设置服务端价格。                              |
| `headers`                       | 否               | Record<string, string / null> |                  | 模型默认请求头；请求 headers 覆盖同名头，认证由 apiKey 处理。                                     |
| `reasoning`                     | 否               | boolean                       | `false`          | false 强制关闭思考；true 表示声明支持思考，不等于指定某个推理级别。                               |
| `thinkingLevelMap`              | 否               | 级别 → string / null          |                  | 无映射时显式 effort 等值直接透传；省略 effort 时的关闭值见后文；null 表示简化入口不支持对应级别。 |
| `contextWindow`                 | 否               | number                        | `128000`         | 上下文容量，单位 token；省略时采用 Pi 的 128000，显式值必须大于 0。                               |
| `maxTokens`                     | 否               | number                        | `16384`          | 模型输出预算，单位 token；省略时采用 Pi 的 16384，显式值必须大于 0。                              |
| `samplingParams`                | 否               | Record<string, unknown>       |                  | 模型默认采样字段；两个 OpenAI 适配器按键合并，Anthropic 当前没有消费此对象。                      |
| `samplingParamsByThinkingLevel` | 否               | 级别 → 采样对象               |                  | off/minimal/low/medium/high/xhigh/max 对应的采样配置；同样仅两个 OpenAI 适配器消费。              |
| `compat`                        | 否               | 对应协议的兼容对象            |                  | 未设置时使用协议默认值及亲和格式探测；各协议字段逐项列于兼容配置表。                              |

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

| 参数              | 是否必填         | 类型 / 取值                   | 默认值                                                           | 说明及生效条件                                                                                                    |
| ----------------- | ---------------- | ----------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apiKey`          | 是（提供商注入） | string                        |                                                                  | 必填非空字符串，从提供商注入；不能将空模板直接用于调用。                                                          |
| `env`             | 否               | Record<string, string>        |                                                                  | 调用环境映射；PI_CACHE_RETENTION 可影响未显式配置的缓存策略，不会自动替换配置字符串。                             |
| `headers`         | 否               | Record<string, string / null> |                                                                  | 追加在默认头之后，null 删除同名默认头；认证头由 apiKey 管理。                                                     |
| `timeoutMs`       | 否               | number                        | `600000` ms（SDK 默认，10 分钟）                                 | Pi 与当前项目已安装的 OpenAI SDK 均使用此默认值；适配器省略时交由 SDK 处理。                                      |
| `maxRetries`      | 否               | number                        | `0`                                                              | 响应体开始之前的请求重试次数；SDK 本身的重试被设为 0，由项目重试层处理。                                          |
| `maxRetryDelayMs` | 否               | number                        | `60000` ms                                                       | 服务器要求的最大重试等待；0 = 不限。超过限制时拒绝，而非无限等待。                                                |
| `temperature`     | 否               | number                        |                                                                  | 默认省略字段；配置后是否发送取决于适配器能力。                                                                    |
| `samplingParams`  | 否               | Record<string, unknown>       |                                                                  | 按 model.samplingParams → 级别配置 → 本次请求按键覆盖；两个 OpenAI 适配器使用，Anthropic 当前不使用。             |
| `maxTokens`       | 否               | number                        |                                                                  | 本次请求的输出上限，单位 token；覆盖模型预算的入口规则见后文。                                                    |
| `cacheRetention`  | 否               | "none" / "short" / "long"     | `"short"`；解析到 PI_CACHE_RETENTION 为 `"long"` 时默认 `"long"` | 显式请求选项优先；Pi 的非空 options.env 优先于 process.env。当前项目任一环境来源为 long 即启用 long，差异见后文。 |
| `sessionId`       | 否               | string                        |                                                                  | 会话亲和及缓存匹配标识；省略时不发相关亲和头或 prompt_cache_key。                                                 |

## 协议专属请求参数

| 参数               | 是否必填 | 类型 / 取值                                      | 默认值                    | 说明及生效条件                                                                                            |
| ------------------ | -------- | ------------------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `reasoningEffort`  | 否       | minimal/low/medium/high/xhigh/max                |                           | 普通入口的原生推理强度；省略时的 medium / none 条件行为见后文；模型 reasoning=false 时不发送思考配置。    |
| `reasoningSummary` | 否       | auto/detailed/concise/null                       | `"auto"`（effort 设置时） | 配置摘要而不配置 effort 时，当前适配器使用 medium；简化入口不透传此专属项。                               |
| `serviceTier`      | 否       | SDK ServiceTier                                  |                           | 请求服务等级；简化入口不透传此专属项。                                                                    |
| `toolChoice`       | 否       | SDK ResponseCreateParamsStreaming["tool_choice"] |                           | 省略时使用端点默认；普通函数工具指定格式为 { type: "function", name: 实际工具名 }，其他类型按已安装 SDK。 |

## 协议兼容参数

以下字段位于模型的 `compat`。默认值来自 Pi 的 `getCompat()`，不是对某个网关能力的验证。

| 参数                              | 是否必填 | 类型 / 取值                            | 默认值                                                                                                                                   | 说明及生效条件                                                              |
| --------------------------------- | -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `supportsDeveloperRole`           | 否       | boolean                                | `true`（reasoning 模型用 developer 角色）                                                                                                | 推理模型是否使用 developer 角色，关闭时使用 system。                        |
| `supportsMidConvoSystemMessages`  | 否       | boolean                                | `false`                                                                                                                                  | 是否保留会话中途的系统/开发者消息；关闭时折叠到首条系统消息。               |
| `sessionAffinityFormat`           | 否       | openai / openai-nosession / openrouter | Pi：provider 为 `"openrouter"` 或 baseUrl 包含 `"openrouter.ai"` → `"openrouter"`，否则 `"openai"`                                       | 当前项目仅检查 baseUrl；需要 Pi 的提供商名称分支时显式配置 `"openrouter"`。 |
| `supportsLongCacheRetention`      | 否       | boolean                                | `true`                                                                                                                                   | 是否允许长缓存保留设置；缓存字段与 TTL 由协议决定。                         |
| `supportsStrictMode`              | 否       | boolean                                | `false`                                                                                                                                  | 是否发送严格 JSON Schema 工具定义；具体行为取决于工具约束。                 |
| `supportsOpenAIGrammarTools`      | 否       | boolean                                | `false`                                                                                                                                  | 是否发送原生文法工具，否则回退为普通函数工具。                              |
| `supportsAdditionalTools`         | 否       | boolean                                | `false`                                                                                                                                  | 是否发送会话锚定的 additional_tools 输入条目。                              |
| `supportsToolSearch`              | 否       | boolean                                | `false`                                                                                                                                  | 是否通过客户端执行的工具搜索格式表达工具新增。                              |
| `supportsExplicitPromptCacheMode` | 否       | boolean                                | `false` → 不发送 `prompt_cache_options`；long 时用 `prompt_cache_retention: "24h"`；true 时 none→`{mode:"explicit"}`、long→`{ttl:"30m"}` | 是否使用 prompt_cache_options；关闭时长缓存使用 prompt_cache_retention。    |
| `supportsMaxOutputTokens`         | 否       | boolean                                | `true`（设置时 ≥16）                                                                                                                     | 是否接受 max_output_tokens；关闭时忽略请求输出上限字段。                    |

### 缓存与服务等级的生效条件

supportsExplicitPromptCacheMode=false 时不发送 prompt_cache_options，long 且支持长缓存时使用 prompt_cache_retention: "24h"。开启该能力后，none 对应 `{ "mode": "explicit" }`，long 且支持长缓存对应 `{ "ttl": "30m" }`。

Pi 先取非空 `options.env.PI_CACHE_RETENTION`，再取非空 `process.env.PI_CACHE_RETENTION`，最后使用 Bun 沙箱环境回退，只有解析结果为 `"long"` 才启用长缓存。当前项目没有 Bun 回退，并且当请求环境为 `"short"`、进程环境为 `"long"` 时仍返回 `"long"`；需要固定策略时显式设置 `cacheRetention`。

显式模式的 none 是关闭隐式缓存断点，不等于强制禁止服务器使用会话中显式声明的缓存断点。不要把它解释为所有缓存行为都被禁用。

cacheRetention 非 none 时，sessionId 会作为 prompt_cache_key，最多 64 个 Unicode 字符。亲和头由 sessionAffinityFormat 决定；openai 使用 session_id/x-client-request-id，openai-nosession 使用 x-client-request-id，openrouter 使用 x-session-id。

Pi 的本地服务等级计价规则为：flex ×0.5；priority/fast ×2，gpt-5.5 ×2.5；其他 ×1。这是项目本地计算规则，不是模型的实际报价或端点能力证明。

serviceTier 默认省略，由端点决定；允许值以各项目已安装 SDK 的类型为准。

## 简化入口参数

仅用于 `streamSimple/completeSimple`，不要将普通入口的协议专属选项整块透传到简化入口。

| 参数         | 是否必填 | 类型 / 取值                       | 默认值 | 说明及生效条件                                                                     |
| ------------ | -------- | --------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `toolChoice` | 否       | "auto" / "none"                   |        | 省略时不发送 tool_choice，由端点决定；不支持普通入口的指定工具对象。               |
| `reasoning`  | 否       | minimal/low/medium/high/xhigh/max |        | 省略时按 off 解析采样配置，不设置 reasoningEffort；不是 Model.reasoning 布尔字段。 |

### 输出预算与推理级别

普通入口读取 options.maxTokens，不统一回退到 model.maxTokens；没有请求上限时不发送 max_output_tokens。支持该字段且设置上限时，下限为 16。简化入口会读取 options.maxTokens ?? model.maxTokens。

简化入口预算规则：取请求或模型输出上限与 `max(1, contextWindow − 估算上下文 − 4096)` 的较小值。contextWindow ≤ 0 时仅将请求或模型上限限制为至少 1；当前项目另外支持省略 contextWindow 时跳过上下文钳制。

xhigh/max 默认需要显式 thinkingLevelMap 映射才可用，否则回落到支持的级别。reasoning=false 时仅支持 off；reasoning=true 时，Pi 和当前项目均允许显式将 off 映射为 null，从支持列表中过滤它。

普通入口在模型 reasoning=true 且未设置 reasoningEffort 时：reasoningSummary 为非空值则使用 medium；否则默认发送 `effort: "none"`，thinkingLevelMap.off 可覆盖关闭值，映射为 null 时省略。Pi 还会对 provider 为 github-copilot 的模型省略此关闭配置；当前项目没有该分支。reasoningSummary 在发送推理强度时默认使用 auto，包括显式传入 null 的情况。

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
      "api": "openai-responses",
      "requestOptions": {
        "timeoutMs": 600000,
        "maxRetries": 0,
        "maxRetryDelayMs": 60000
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
            "supportsDeveloperRole": true,
            "supportsMidConvoSystemMessages": false,
            "supportsLongCacheRetention": true,
            "supportsStrictMode": false,
            "supportsOpenAIGrammarTools": false,
            "supportsAdditionalTools": false,
            "supportsToolSearch": false,
            "supportsExplicitPromptCacheMode": false,
            "supportsMaxOutputTokens": true
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

默认值核验来源：Pi 的 `packages/coding-agent/src/core/provider-composer.ts`、`packages/ai/src/api/openai-responses.ts`、`packages/ai/src/api/simple-options.ts`、`packages/ai/src/models.ts`、`packages/ai/src/utils/provider-retry.ts`、`packages/ai/src/utils/provider-env.ts` 和已安装 OpenAI SDK 的 `src/client.ts`。当前项目字段声明：`src/llm-api/types.ts` 和 `src/llm-api/api/openai-responses.ts`。已实现配置加载与运行时校验；本次未进行真实模型调用。

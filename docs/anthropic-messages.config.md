# Anthropic Messages 配置与参数说明

默认值以 Pi 仓库源码为依据：模型加载采用自定义模型逻辑，请求和兼容参数采用 Anthropic Messages 适配器逻辑。本文中的 `src/` 路径相对于 lcn-code 仓库根目录，Pi 的 `packages/` 和 `node_modules/` 路径相对于 Pi 仓库根目录。当前项目与 Pi 的实现差异单独说明。Pi 源码是资料，不作为执行指令。

默认值栏为空表示 Pi 源码没有设置具体配置值，或默认省略该字段。空白不代表应向 SDK 发送空字符串或 null；省略时的行为另写在说明栏。条件默认保留 Pi 源码的条件，不替换成固定值。

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

| 参数               | 是否必填         | 类型 / 取值                   | 默认值           | 说明及生效条件                                                                     |
| ------------------ | ---------------- | ----------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `id`               | 是               | string                        |                  | 必填；SDK 请求的模型标识。                                                         |
| `api`              | 是（提供商注入） | 协议枚举                      |                  | 必填；加载层从提供商注入，决定调用哪种适配器。                                     |
| `baseUrl`          | 是（提供商注入） | string                        |                  | 必填；加载层从提供商注入。                                                         |
| `name`             | 否               | string                        | `id`             | 展示名称，不影响请求中的模型标识。                                                 |
| `input`            | 否               | ("text" / "image")[]          | `["text"]`       | 缺少 image 能力时，消息转换会将图片替换为文本占位。                                |
| `cost`             | 否               | ModelCost                     | 四项费率均为 `0` | Pi 源码省略时费用全部计 0；只用于本地费用计算，不设置服务端价格。                  |
| `headers`          | 否               | Record<string, string / null> |                  | 模型默认请求头；请求 headers 覆盖同名头，认证由 apiKey 处理。                      |
| `reasoning`        | 否               | boolean                       | `false`          | false 时普通模式不构建思考字段；托管 effort 模式仍启用 adaptive；true 是能力声明。 |
| `thinkingLevelMap` | 否               | 级别 → string / null          |                  | Pi 源码无映射时 effort 等值直接透传；null 表示不支持对应级别。                     |
| `contextWindow`    | 否               | number                        | `128000`         | 上下文容量，单位 token；省略时采用 Pi 的 128000，显式值必须大于 0。                |
| `maxTokens`        | 否               | number                        | `16384`          | 模型输出预算，单位 token；省略时采用 Pi 的 16384，显式值必须大于 0。               |
| `compat`           | 否               | 对应协议的兼容对象            |                  | Pi 源码未设置时使用提供商及 URL 探测默认值；各协议字段逐项列于兼容配置表。         |

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

| 参数              | 是否必填                     | 类型 / 取值                   | 默认值                                                         | 说明及生效条件                                                                         |
| ----------------- | ---------------------------- | ----------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apiKey`          | 是（提供商注入）             | string                        |                                                                | 必填非空字符串，从提供商注入；不能将空模板直接用于调用。                               |
| `env`             | 否                           | Record<string, string>        |                                                                | 调用环境映射；PI_CACHE_RETENTION 可影响未显式配置的缓存策略，不会自动替换配置字符串。  |
| `headers`         | 否                           | Record<string, string / null> |                                                                | 追加在默认头之后，null 删除同名默认头；认证头由 apiKey 管理。                          |
| `timeoutMs`       | 否                           | number                        | `600000` ms（SDK 默认）                                        | 请求超时，单位毫秒；未配置时采用 Anthropic SDK 的 10 分钟默认值。                      |
| `maxRetries`      | 否                           | number                        | `0`                                                            | 响应体开始之前的请求重试次数；SDK 本身的重试被设为 0，由项目重试层处理。               |
| `maxRetryDelayMs` | 否                           | number                        | `60000` ms                                                     | 服务器要求的最大重试等待；0 = 不限。超过限制时拒绝，而非无限等待。                     |
| `temperature`     | 否                           | number                        |                                                                | Pi 源码默认省略字段；配置后是否发送取决于适配器能力。                                  |
| `maxTokens`       | 条件必填：模型或请求至少一处 | number                        |                                                                | 本次请求的输出上限，单位 token；覆盖模型预算的入口规则见后文。                         |
| `cacheRetention`  | 否                           | "none" / "short" / "long"     | `"short"`；环境 PI_CACHE_RETENTION 为 `"long"` 时默认 `"long"` | Pi 中显式选项优先，其次 options.env 的非空值，再其次 process.env；当前项目差异见后文。 |
| `sessionId`       | 否                           | string                        |                                                                | 会话亲和及缓存匹配标识；Pi 源码省略时不发相关亲和头或 prompt_cache_key。               |
| `metadata`        | 否                           | Record<string, unknown>       |                                                                | 仅 Anthropic 读取字符串 metadata.user_id；当前两个 OpenAI 适配器不发送此对象。         |

### metadata 的协议字段

| 参数               | 是否必填 | 类型 / 取值 | 默认值 | 说明及生效条件                                               |
| ------------------ | -------- | ----------- | ------ | ------------------------------------------------------------ |
| `metadata.user_id` | 否       | string      |        | 当前适配器仅发送 metadata 中的这个字符串字段，其他键不发送。 |

## 协议专属请求参数

| 参数                   | 是否必填 | 类型 / 取值                  | 默认值                       | 说明及生效条件                                                                                                      |
| ---------------------- | -------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `thinkingEnabled`      | 否       | boolean                      |                              | 普通模式省略时不发送 thinking；托管 effort 模式始终发送 adaptive。配置 true 的普通模式还要求 model.reasoning=true。 |
| `thinkingBudgetTokens` | 否       | number                       | `1024`                       | 预算型思考的 token 数；自适应思考不使用此预算。                                                                     |
| `effort`               | 否       | low/medium/high/xhigh/max    | `"high"`（托管 effort 模型） | 自适应思考的原生强度；托管模式使用当前/历史 effort。普通自适应模式省略该项时不额外设置 output_config.effort。       |
| `thinkingDisplay`      | 否       | summarized/omitted           | `"summarized"`               | 启用思考时控制思考内容展示格式。                                                                                    |
| `interleavedThinking`  | 否       | boolean                      | `true`                       | 非强制自适应且启用思考时，控制是否添加交错思考 beta。                                                               |
| `toolChoice`           | 否       | auto/any/none 或指定工具对象 |                              | 省略时使用端点默认；指定对象格式为 { type: "tool", name: 实际工具名 }。                                             |

## 协议兼容参数

以下字段位于模型的 `compat`。默认值是 Pi 源码中的省略行为，不是对某个网关能力的验证。

| 参数                              | 是否必填 | 类型 / 取值                     | 默认值                                                      | 说明及生效条件                                                               |
| --------------------------------- | -------- | ------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `supportsEagerToolInputStreaming` | 否       | boolean                         | `true`                                                      | 是否在工具上发送 eager_input_streaming；关闭且有工具时使用兼容 beta。        |
| `supportsLongCacheRetention`      | 否       | boolean                         | `true`                                                      | 是否允许长缓存保留设置；缓存字段与 TTL 由协议决定。                          |
| `sendSessionAffinityHeaders`      | 否       | boolean                         | `provider === "openrouter"` 或 `baseUrl` 含 `openrouter.ai` | 是否根据 sessionId 发送亲和头。                                              |
| `sessionAffinityFormat`           | 否       | "openrouter"                    | 满足上述 OpenRouter 条件时 `"openrouter"`，否则省略         | 决定具体亲和头名称；Anthropic 只允许 openrouter 或省略。                     |
| `supportsCacheControlOnTools`     | 否       | boolean                         | `true`                                                      | 是否在工具定义中附加 cache_control。                                         |
| `supportsTemperature`             | 否       | boolean                         | `true`                                                      | 是否发送 temperature。                                                       |
| `forceAdaptiveThinking`           | 否       | boolean                         | `false`                                                     | 是否强制使用 adaptive 思考格式，启用时按 effort 控制而非固定预算。           |
| `allowEmptySignature`             | 否       | boolean                         | `false`                                                     | 是否保留空思考签名；关闭时缺少签名的思考内容转为普通文本。                   |
| `supportsStrictTools`             | 否       | boolean                         | `false`                                                     | 是否发送 Anthropic 严格工具 Schema。                                         |
| `supportsMidConvoEffort`          | 否       | boolean                         | `false`                                                     | 是否发送会话内 effort 系统消息；启用后采用托管 adaptive 思考与前缀绑定控制。 |
| `supportsMidConvoSystemMessages`  | 否       | boolean                         | `false`                                                     | 是否保留会话中途的系统/开发者消息；关闭时折叠到首条系统消息。                |
| `supportsMidConvoToolChanges`     | 否       | boolean                         | `false`                                                     | 是否原生发送工具新增与删除块；需同时支持中途系统消息。                       |
| `allowedFallbackModels`           | 否       | AnthropicAllowedFallbackModel[] |                                                             | 端点允许的服务器回退模型列表；空或省略时不发送 fallbacks。                   |

### 回退模型的嵌套字段

| 参数                            | 是否必填             | 类型 / 取值 | 默认值 | 说明及生效条件                                       |
| ------------------------------- | -------------------- | ----------- | ------ | ---------------------------------------------------- |
| `allowedFallbackModels[].model` | 是（配置回退条目时） | string      |        | 实际端点允许的回退模型标识；不能为空或根据名称推测。 |
| `allowedFallbackModels[].cost`  | 否                   | ModelCost   |        | 回退模型的本地计价元数据；字段结构与模型 cost 一致。 |

### 思考和缓存的生效条件

普通预算型思考需要 model.reasoning=true 且 thinkingEnabled=true；thinkingBudgetTokens 省略时使用 1024。Pi 使用 `options.thinkingBudgetTokens || 1024`，因此显式 0 也回到 1024；当前项目使用 `?? 1024`。强制自适应思考使用 effort，不使用预算型 token 配置。supportsMidConvoEffort 的托管模式会设置 adaptive 思考和前缀绑定控制，不能仅靠 thinkingEnabled=false 关闭该模式。

普通 adaptive 模式没有给 effort 配置值时，不额外发送 output_config.effort；Pi 源码的 high 默认明确用于托管 effort 模型。

Pi 源码的缓存构建结果为：short 使用 `{ "type": "ephemeral" }`；long 且支持长缓存时增加 `"ttl": "1h"`。none 不添加缓存控制标记。

beta 标识由适配器按条件构建，不是额外必填配置：无 eager 且有工具时使用 fine-grained-tool-streaming-2025-05-14；预算思考按 interleavedThinking 使用 interleaved-thinking-2025-05-14；配置回退时使用 server-side-fallback-2026-07-01；托管 effort 使用 mid-conversation-output-config-2026-07-01 和 thinking-binding-controls-2026-08-01；原生工具变更使用 inline-tools-2026-09-15。

## 简化入口参数

仅用于 `streamSimple/completeSimple`，不要将普通入口的协议专属选项整块透传到简化入口。

| 参数                      | 是否必填 | 类型 / 取值                       | 默认值                                                    | 说明及生效条件                                                                           |
| ------------------------- | -------- | --------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `toolChoice`              | 否       | "auto" / "none"                   |                                                           | 省略时不发送 tool_choice，由端点决定；不支持普通入口的指定工具对象。                     |
| `reasoning`               | 否       | minimal/low/medium/high/xhigh/max |                                                           | 普通模式省略时关闭思考；托管 effort 模式仍启用 adaptive；不是 Model.reasoning 布尔字段。 |
| `thinkingBudgets`         | 否       | ThinkingBudgets                   | `{ minimal: 1024, low: 2048, medium: 8192, high: 16384 }` | 用于预算型思考；Responses 没有独立预算 token 请求字段。                                  |
| `thinkingBudgets.minimal` | 否       | number                            | `1024`                                                    | 最小级别预算，单位 token。                                                               |
| `thinkingBudgets.low`     | 否       | number                            | `2048`                                                    | 低级别预算，单位 token。                                                                 |
| `thinkingBudgets.medium`  | 否       | number                            | `8192`                                                    | 中级别预算，单位 token。                                                                 |
| `thinkingBudgets.high`    | 否       | number                            | `16384`                                                   | 高级别预算，单位 token。                                                                 |

### 输出预算与推理级别

普通入口使用 options.maxTokens ?? model.maxTokens，两者都没有时由 requireMaxTokens 报错。简化入口在预算型思考中还会调整思考预算和输出预算。

Pi 的简化入口预算规则：请求上限取 options.maxTokens ?? model.maxTokens，再与 contextWindow − 估算上下文 − 4096 安全余量（下限为 1）取较小值；contextWindow ≤ 0 时仅将请求上限限制为至少 1。当前项目另外支持省略 contextWindow 时跳过上下文钳制。预算型思考在输出上限不大于思考预算时，将思考预算限制为 max(0, 输出上限 − 1024)，为答案保留空间。

xhigh/max 默认需要显式 thinkingLevelMap 映射才可用，否则回落到支持的级别。Pi 中 model.reasoning=false 时支持列表为 ["off"]；model.reasoning=true 时，显式把 off 映射为 null 会将其从支持列表中过滤。

Model.reasoning 是布尔能力声明；简化选项 reasoning 是级别字符串，普通选项使用协议自己的强度字段，三者不可混为同一个键。

## 标准 JSON 配置模板

下面是待填写的配置模板，非可直接调用的配置。必填字符串没有默认值，按要求留空；没有具体默认值的可选项在 JSON 中省略，在前面的参数表完整列出。条件默认也保持省略，由适配器在运行时解析。

模板填写 Pi 已核实的固定默认值；temperature、sessionId 和条件默认保持省略，模型名称由 id 补齐。api 字段是本文件对应协议的固定标识，不是自动推测的默认协议。

```json
{
  "provider": "",
  "model": "",
  "modelProviders": [
    {
      "name": "",
      "baseUrl": "",
      "apiKey": "",
      "api": "anthropic-messages",
      "requestOptions": {
        "timeoutMs": 600000,
        "maxRetries": 0,
        "maxRetryDelayMs": 60000,
        "thinkingBudgetTokens": 1024,
        "thinkingDisplay": "summarized",
        "interleavedThinking": true
      },
      "models": [
        {
          "id": "",
          "input": ["text"],
          "compat": {
            "supportsEagerToolInputStreaming": true,
            "supportsLongCacheRetention": true,
            "supportsCacheControlOnTools": true,
            "supportsTemperature": true,
            "forceAdaptiveThinking": false,
            "allowEmptySignature": false,
            "supportsStrictTools": false,
            "supportsMidConvoEffort": false,
            "supportsMidConvoSystemMessages": false,
            "supportsMidConvoToolChanges": false
          }
        }
      ]
    }
  ]
}
```

模板未填写 maxTokens；通过 loadAiConfig 读取时，模型采用 Pi 的默认值 16384。绕过读取器直接调用适配器时，仍必须提供模型或请求的 maxTokens。模板省略 effort 和 cacheRetention，保留托管 effort 的 high 条件默认及 PI_CACHE_RETENTION 的缓存条件默认。

### 当前项目与 Pi 的运行时差异

Pi 的 OpenRouter 亲和探测同时检查 `model.provider === "openrouter"` 和 `baseUrl.includes("openrouter.ai")`；当前项目仅检查 baseUrl。若提供商名称为 openrouter 且使用其他 URL，当前项目须显式设置 `sendSessionAffinityHeaders: true` 和 `sessionAffinityFormat: "openrouter"` 才能获得 Pi 的默认行为。

Pi 先读取 options.env 中的非空 PI_CACHE_RETENTION，再读取 process.env；当前项目只要任一处等于 long 就使用 long。因此 options.env 为 short、process.env 为 long 时，Pi 默认 short，当前项目默认 long。

## 加载和运行时边界

通过 loadAiConfig 显式读取 settings.json，加载规则是：精确选择提供商和模型，提供商 api/baseUrl 注入 Model，apiKey 注入请求选项；请求默认值按提供商 → 模型 → 本次调用覆盖。headers/samplingParams/thinkingBudgets 按键合并，其他选项按完整值替换。读取、参数校验或选择失败时抛出异常，不使用内建配置。

`${BASE_URL}`、`${API_KEY}` 的替换已由加载层实现，按 .env 的非空值 → 环境变量的非空值 → 抛出异常处理；模板继续保留必填空字符串，由使用者填写。

`inputLimits` 和 `promptCache` 可通过配置校验并保留到运行时 Model，但当前三个适配器均未消费这些字段；不执行图片缩放、请求大小/图片数量限制，也不通过它们设置缓存 TTL。实际缓存行为由 `cacheRetention` 和协议兼容参数决定。

重复提供商名称和模型 ID 使用最后一项；未知字段采用宽松校验，不代表相应字段会被适配器消费。

会话内容与默认配置分开提供。模型、请求和兼容配置需要在使用边界验证；参数类型或字段文档不能验证实际端点支持情况。

默认值来源：Pi 的 `packages/coding-agent/src/core/provider-composer.ts`（modelFromJson）、`packages/ai/src/api/anthropic-messages.ts`、`packages/ai/src/api/simple-options.ts`、`packages/ai/src/types.ts`、`packages/ai/src/utils/provider-retry.ts`、`packages/ai/src/utils/provider-env.ts` 和当前安装的 `node_modules/@anthropic-ai/sdk/src/client.ts`。字段声明：`src/ai/types.ts` 和对应的 `src/ai/api/anthropic-messages.ts`。已实现配置加载与运行时校验；未进行真实模型调用。

# lcn-code

一个终端 AI 编码代理，通过学习 [Pi](https://github.com/earendil-works/pi) 的源码与架构后从零重写而成。

AI 配置通过 `loadAiConfig()` 显式读取 `settings.json`；环境变量按 `.env` → 进程环境 → 抛出异常处理。

本项目并非 Pi 的 fork 或二次分发，而是在理解其设计思路的基础上，使用 TypeScript 独立实现的编码代理。目标是在实践中深入掌握 Agent 运行时、工具调用、会话管理等核心机制，并按照自己的需求进行裁剪与扩展。

## 项目状态

> **早期开发阶段** — 功能尚不完整，接口随时可能变动，暂不建议用于生产环境。

## 技术栈

- **运行时**: Node.js >= 22
- **语言**: TypeScript 7 (ES Module)
- **包管理**: npm
- **代码格式化**: Prettier
- **构建**: tsc (目标 ES2024, 模块 NodeNext)

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/StarMeteoritePavilion/lcn-code.git
cd lcn-code

# 安装依赖
npm install

# 复制配置文件并填入你的密钥
cp .env.example .env
cp settings.example.json settings.json

# 类型检查
npm run check

# 构建
npm run build

# 运行测试
npm test

# 在 .env 填写 BASE_URL、API_KEY，并准备 JPEG 格式的 docs/logo.jpg
# 运行所选协议的全部适用场景；会发起多次真实模型请求
# provider、model 必须精确匹配 settings.json 中的提供商名称和模型 ID
node dist/main.js
```

## 项目结构

```
lcn-code/
├── src/               # 源码目录
│   ├── llm-api/      # 三协议适配器、消息与工具、模型目录和通用工具
│   ├── config/       # 配置读取、环境替换和 AI 配置校验
│   └── main.ts       # 协议演示入口
├── test/              # 与 src 对应的 Node.js 内置测试
├── scripts/           # 构建辅助及源码规范检查脚本
├── docs/              # AI 接口及三协议配置文档、演示图片
├── .env.example       # 环境变量示例
├── settings.example.json # 本地配置示例
├── tsconfig.json      # 源码构建配置
├── tsconfig.test.json # 测试编译配置
└── package.json       # 项目清单
```

## 可用脚本

| 命令                    | 说明                                                 |
| ----------------------- | ---------------------------------------------------- |
| `npm run check`         | TypeScript 类型检查（不生成产物）                    |
| `npm run build`         | 清理 dist 目录后编译                                 |
| `npm test`              | 编译测试代码并运行                                   |
| `npm run format`        | 使用 Prettier 格式化代码                             |
| `npm run check:source`  | 源码大括号、调用嵌套、显式类型、TSDoc 与部分命名检查 |
| `npm run test:coverage` | 编译运行测试并报告 src 覆盖率                        |
| `npm run verify`        | 格式检查 + 源码规范检查 + 测试 + 构建（完整验证）    |

## 运行与验证

`node dist/main.js` 根据 `settings.json` 选中的模型协议运行演示，不会依次调用三个协议。每个适用场景分别使用 `stream`、`complete`、`streamSimple`、`completeSimple` 四种入口；图片、思考、严格工具与语法工具场景根据配置能力执行或跳过。演示读取 JPEG 格式的 `docs/logo.jpg`，即使模型不支持图片也需要该文件。结束时输出成功、失败、跳过数量及原生事件数量；场景失败时退出码为 1，按 Ctrl+C 中断请求。

提交前运行 `npm run verify`，检查格式与源码规范、编译并运行离线测试、构建源码；该命令不运行真实模型演示。测试编译产物位于 `.build/test`，构建产物位于 `dist`，对应脚本会先清理各自产物目录。

```bash
# 使用 Node.js 内置覆盖率报告检查实际执行的源码分支
npm run test:coverage
```

源码规范脚本自动检查明确的语法、文档与部分命名规则；卫语句选择、接口必要性、配置校验及文档与行为一致性仍需人工检查。

覆盖率报告仅统计编译后的 `src` 文件；除查看行、分支和函数覆盖率外，还应检查每个导出函数的正常路径、边界值及异常输入，不能仅凭总覆盖率判断符合测试规范。

## 接口与配置文档

- [Anthropic Messages 配置](docs/anthropic-messages.config.md)
- [OpenAI Completions 配置](docs/openai-completions.config.md)
- [OpenAI Responses 配置](docs/openai-responses.config.md)

配置加载不发现内建模型，也不按名称推断能力。`settings.example.json` 的提供商、模型与兼容参数需要按实际端点配置。示例中的 `inputLimits`、`promptCache` 当前只进行结构校验并保留到模型对象，不执行图片缩放、请求大小/图片数量限制，也不改变协议缓存 TTL；详情见 AI 接口文档。

## 致谢

本项目的架构设计与实现思路主要受以下开源项目启发：

- [Pi](https://github.com/earendil-works/pi) — 一个极简、可扩展的 Agent 框架，本项目最直接的学习对象

## 许可证

[MIT](./LICENSE)

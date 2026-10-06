# lcn-code

一个终端 AI 编码代理，通过学习 [Pi](https://github.com/earendil-works/pi) 的源码与架构后从零重写而成。

本项目并非 Pi 的 fork 或二次分发，而是在理解其设计思路的基础上，使用 TypeScript 独立实现的编码代理。目标是在实践中深入掌握 Agent 运行时、工具调用、会话管理等核心机制，并按照自己的需求进行裁剪与扩展。

## 项目状态

> **早期开发阶段** — 功能尚不完整，接口随时可能变动，暂不建议用于生产环境。

## 技术栈

- **运行时**: Node.js >= 22
- **语言**: TypeScript 7 (ES Module)
- **包管理**: npm
- **代码格式化**: Prettier
- **构建**: tsc (目标 ES2022, 模块 NodeNext)

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/StarMeteoritePavilion/lcn-code.git
cd lcn-code

# 安装依赖
npm install

# 复制配置文件并填入你的密钥
cp .env.example .env
cp setting.example.json setting.json

# 类型检查
npm run check

# 构建
npm run build

# 运行测试
npm test
```

## 项目结构

```
lcn-code/
├── src/               # 源码目录
│   └── index.ts        # 入口文件
├── test/              # 测试目录
├── scripts/           # 构建辅助脚本
├── docs/              # 文档
├── .env.example       # 环境变量示例
├── setting.example.json # 本地配置示例
├── tsconfig.json      # TypeScript 配置
└── package.json       # 项目清单
```

## 可用脚本

| 命令             | 说明                               |
| ---------------- | ---------------------------------- |
| `npm run check`  | TypeScript 类型检查（不生成产物）  |
| `npm run build`  | 清理 dist 目录后编译               |
| `npm test`       | 编译测试代码并运行                 |
| `npm run format` | 使用 Prettier 格式化代码           |
| `npm run verify` | 格式检查 + 测试 + 构建（完整验证） |

## 致谢

本项目的架构设计与实现思路主要受以下开源项目启发：

- [Pi](https://github.com/earendil-works/pi) — 一个极简、可扩展的 Agent 框架，本项目最直接的学习对象

## 许可证

[MIT](./LICENSE)

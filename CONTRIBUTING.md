# 参与贡献 Uni LLM Bench

[English](CONTRIBUTING-en.md) | **中文**

感谢你愿意贡献！本文档覆盖开发环境搭建、CI 执行的检查项，以及保持一致性的代码约定。

## 开发环境

### 前置要求

- Node.js 20+（CI 跑在 Node 20）
- npm 10+
- Git

### 本地开发

```bash
git clone https://github.com/zj-unicom-ai/uni-llm-bench.git
cd uni-llm-bench
cp .env.example .env

# 后端 — http://localhost:3001
cd backend && npm install && npm run dev &

# 前端 — http://localhost:5173
cd ../frontend && npm install && npm run dev
```

后端监听 `src/` 并自动重启；前端使用 Vite HMR，并把 `/api` 代理到 3001 端口。生产环境下，构建后的前端由 Express 在 3001 端口托管。

健康检查：`curl http://localhost:3001/api/health` → `{"status":"ok"}`。

> **关于登录**：`.env` 里的 `AUTH_PASSWORD` 只在首次（`users` 表为空时）用于初始化管理员账号。一旦你在界面里改过密码，新的哈希就存在数据库里，`.env` 不再生效——请改用你在界面设置的密码。

### Docker

```bash
cp .env.example .env
docker compose up -d
```

## 项目结构

```
├── backend/
│   └── src/
│       ├── providers/     # Provider 适配器（OpenAI、Anthropic、Gemini 等）
│       ├── routes/        # API 路由处理
│       ├── services/      # 基准 / 工作流 / 身份引擎与各 store
│       ├── middleware/    # 认证
│       ├── utils/         # 密钥、加密、定价、错误分类
│       └── validation/    # Zod schema
├── frontend/
│   └── src/
│       ├── components/    # UI 组件与页面
│       ├── hooks/         # 数据请求 hook
│       ├── i18n/          # en.json / zh.json（保持同步，有测试校验）
│       ├── services/      # API 客户端
│       ├── utils/         # token 计数、成本预估、演示模式
│       └── data/          # 长上下文合成语料（1k–256k，项目自研）
├── design/                # 设计文档（中英双份）
├── docs/screenshots/      # README 配图
├── docker-compose.yml
├── Dockerfile
└── start.sh
```

## 提 PR 前要跑的检查

以下检查在每次 push 和 PR 时都会由 CI 执行。先在本地跑一遍，免得等一个红色的构建：

```bash
# 前端
cd frontend && npx tsc --noEmit
cd frontend && npx eslint .
cd frontend && npm test

# 后端
cd backend && npx tsc --noEmit
cd backend && npx eslint .
cd backend && npm test
```

### 格式化

提交前用 Prettier 格式化改动：

```bash
npx prettier --write .
```

仓库的 Prettier 配置在 `.prettierrc`，忽略构建产物、数据库文件以及根目录的 `README.md`。请保持新增和改动文件已格式化。（部分存量源文件尚未 Prettier 化，我们会择机清理——它们不阻塞 CI，但新增代码应当是格式化过的。）

## 代码约定

- **语言** — 代码、注释与提交信息使用英文。面向用户的文案放进 `frontend/src/i18n/`，且英文与中文都要有。
- **提交信息** — 遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`feat:`、`fix:`、`docs:`、`refactor:`、`chore:`、`style:`、`ci:`、`test:`
- **前端** — React 函数组件、TypeScript strict 模式、Tailwind CSS v4。设计令牌在 `frontend/src/index.css`，请复用而不要硬编码颜色。
- **Ant Design** — 从 `frontend/src/antdImports.ts` 导入 antd 组件，不要直接从 `antd` 导入，以保证打包产物可控。
- **后端** — 路由 → 服务 → SQLite。用 `better-sqlite3` 写裸 SQL，不使用 ORM，且**必须参数化**（绝不把请求输入拼接进 SQL 字符串）。
- **测量** — 测不到的指标不要补默认值或模拟值，返回 `null`，让界面显示 `N/A`。这是硬性规则，详见 README 的「测量可信度」章节。

### 值得知道的坑

**给 provider 的 model 增加字段需要改三处。** `models` 列是 JSON，无需迁移，但字段会被静默丢弃，除非你同时更新：

1. `backend/src/types.ts` → `ModelConfig`
2. `backend/src/validation/schemas.ts` → `ModelConfigSchema`（Zod 会剥离未知 key，未登记字段到不了 handler）
3. `backend/src/routes/providers.ts` → create（POST `/`）与 update（PUT `/:id`）两处，它们是逐字段显式映射的

**新增页面需要改两个文件。** 先把 key 加进 `components/Sidebar.tsx` 的 `PageType` 联合类型与 `groups` 数组，再在 `App.tsx` 里补上 `PAGE_ROUTES`、`pageConfig`、`activePage` 的路径识别与 `<Route>`。

**i18n key 必须同步。** `frontend/src/i18n/i18n.test.ts` 会断言 `en.json` 与 `zh.json` 的 key 完全一致且非空。只加一边会导致构建失败。

**引导是页面级的。** 引导步骤通过 `data-tour` 属性定位元素，触发按钮放在页面内部而非全局顶栏，参见 `components/GuidedTour.tsx`。

**长篇文档均提供中英双份镜像。** `design/DESIGN.md` ↔ `design/DESIGN-en.md`、`README.md` ↔ `README-en.md`、`CONTRIBUTING.md` ↔ `CONTRIBUTING-en.md`、`SECURITY.md` ↔ `SECURITY-en.md`、`CHANGELOG.md` ↔ `CHANGELOG-en.md`，改一边必须同步另一边。新条目写在 `[Unreleased]` 下；发版时移到新的 `## [x.y.z] - YYYY-MM-DD` 标题下，已发布的段落不要改写。

## 新增 Provider 适配器

1. 在 `backend/src/providers/` 下按既有模式创建适配器
2. 实现与 `DynamicProvider`（`backend/src/providers/adapter.ts`）一致的接口：每种 wire format 一条非流式 + 一条流式代码路径（`callOpenAI` / `callOpenAIStreaming`、`callAnthropic` / `callAnthropicStreaming`、`callGemini` / `callGeminiStreaming`），统一由 `execute()` 暴露
3. 在 provider 工厂中注册
4. 把新格式加入 `backend/src/types.ts`、Zod schema，以及模型库的格式选择器
5. 所有成本计算走统一的定价模块，不要在适配器里加单价常量

## 如何贡献

### 报告缺陷

1. 先搜索[已有 issue](https://github.com/zj-unicom-ai/uni-llm-bench/issues)
2. 使用 **Bug Report** 模板
3. 附上复现步骤、期望与实际行为，以及必要的截图

### 建议功能

1. 用 **Feature Request** 模板开 issue
2. 说明使用场景与价值

### 提交代码

1. Fork 本仓库
2. 从 `main` 建分支：
   ```bash
   git checkout -b feat/your-feature
   ```
3. 按上述约定完成改动
4. 跑一遍上面的检查
5. 用清晰的提交信息提交：
   ```bash
   git commit -m "feat: add support for X"
   ```
6. Push 并对 `main` 发起 Pull Request

请保持 PR 聚焦——一个 PR 只做一件逻辑改动，评审会快很多。

## 许可证

提交贡献即表示你同意你的贡献以 [MIT License](LICENSE) 授权。

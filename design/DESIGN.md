# Uni LLM Bench — 设计文档

> 版本：v0.0.1 · 最后更新：2026-09-10
> English version: [DESIGN-en.md](./DESIGN-en.md)

## 目录

- [1. 概览](#1-概览)
- [2. 架构](#2-架构)
- [3. 后端](#3-后端)
  - [3.1 进程与中间件管线](#31-进程与中间件管线)
  - [3.2 认证与授权](#32-认证与授权)
  - [3.3 请求校验](#33-请求校验)
  - [3.4 Provider 适配层](#34-provider-适配层)
  - [3.5 基准测试引擎](#35-基准测试引擎)
  - [3.6 工作流引擎](#36-工作流引擎)
  - [3.7 模板库](#37-模板库)
  - [3.8 模型身份核验](#38-模型身份核验)
  - [3.9 质量评测](#39-质量评测)
  - [3.10 持久化层](#310-持久化层)
- [4. 前端](#4-前端)
  - [4.1 技术栈](#41-技术栈)
  - [4.2 路由与页面](#42-路由与页面)
  - [4.3 组件地图](#43-组件地图)
  - [4.4 状态管理](#44-状态管理)
  - [4.5 主题与设计令牌](#45-主题与设计令牌)
  - [4.6 国际化](#46-国际化)
  - [4.7 新手引导](#47-新手引导)
  - [4.8 Token 计数与成本预估](#48-token-计数与成本预估)
- [5. 数据模型](#5-数据模型)
- [6. API 参考](#6-api-参考)
- [7. 实时（SSE）契约](#7-实时sse契约)
- [8. 安全](#8-安全)
- [9. 配置与部署](#9-配置与部署)
- [10. 测试](#10-测试)
- [11. 项目结构](#11-项目结构)
- [12. 已知缺口与说明](#12-已知缺口与说明)

---

## 1. 概览

Uni LLM Bench 是一个自托管的 Web 应用，用来测量和对比 LLM API 端点。用户登记 provider（OpenAI、
Anthropic、Google Gemini，或任意 OpenAI 兼容网关），编排多任务的基准工作流，并以延迟分位数、吞吐、
成本和跨模型排名来读结果。它还回答一个纯测速工具答不了的问题：*这个端点背后的模型，是它自称的那个吗？*

**能力矩阵**

| 能力 | 入口 | 支撑模块 |
| --- | --- | --- |
| 多任务基准工作流 | `/workflow` | `services/workflowEngine.ts` + `services/benchmarkEngine.ts` |
| 运行历史、详情图表、导出 | `/history`、`/history/:id` | `services/workflowStore.ts`、`utils/csv.ts` |
| 可复用任务模板 | `/modules` | `services/workflowTemplateStore.ts`、`services/templateSeed.ts` |
| Provider 与模型登记 | `/modellibrary` | `services/providerStore.ts`、`routes/providers.ts` |
| 模型身份核验 | `/identity` | `services/identityEngine.ts`、`services/identityProbes.ts` |
| 交互式单提示词调试 | `/playground` | `routes/playground.ts`、`services/playgroundHistoryStore.ts` |
---

## 2. 架构

```
┌──────────────────────────────────────────────────────────────┐
│                           浏览器                             │
│  React 19 · Ant Design 6 · Recharts · Tailwind CSS v4        │
│  i18next（中/英）· Framer Motion                              │
└──────────────────────────────┬───────────────────────────────┘
                               │ REST（Bearer JWT） · SSE（一次性 token）
┌──────────────────────────────▼───────────────────────────────┐
│                        Express 服务                           │
│  ┌───────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ helmet /  │  │ 认证中间件    │  │ zod 校验              │  │
│  │ CORS      │  │              │  │ req.body = 解析结果    │  │
│  └─────┬─────┘  └──────┬───────┘  └───────────┬───────────┘  │
│        └───────────────┴──────────────────────┘              │
│                         │                                    │
│  ┌──────────────────────▼─────────────────────────────────┐  │
│  │                      路由层                            │  │
│  │  auth · providers · benchmarks · workflows · templates │  │
│  │  playground · identity                                   │  │
│  └──────────────────────┬─────────────────────────────────┘  │
│  ┌──────────────────────▼─────────────────────────────────┐  │
│  │                      服务层                            │  │
│  │  benchmarkEngine · workflowEngine · identityEngine     │  │
│  │  capabilityTester · stores（内存 Map + SQLite 写穿）    │  │
│  │  stores（内存 Map + SQLite 写穿）                       │  │
│  └──────────────────────┬─────────────────────────────────┘  │
│  ┌──────────────────────▼─────────────────────────────────┐  │
│  │                   Provider 适配器                      │  │
│  │  DynamicProvider：openai · anthropic · gemini · custom  │  │
│  └──────────────────────┬─────────────────────────────────┘  │
└─────────────────────────┼────────────────────────────────────┘
                          │
              ┌───────────▼────────────┐
              │ SQLite (better-sqlite3)│
              │ WAL 模式 · 单文件       │
              └────────────────────────┘
```

全部运行在**单个 Node.js 进程**里：没有 Redis、没有队列、没有外部数据库。生产环境由 Vite 把前端编译成静态
资源交给 Express 托管；开发环境 Vite dev server（5173 端口）把 `/api` 代理到后端（3001 端口）。

由此产生两条约束，贯穿整个系统设计：

1. **进行中的任务只存在于内存。** 一次运行中的基准测试存放在 store 的 `Map` 里。进程一旦死掉，这次运行永远
   不可能结束——所以启动时会把遗留的 `running` 记录修正为 `interrupted`，而不是让界面永远转圈。
2. **长任务用流式推送而非轮询。** 进度通过 SSE 到达浏览器，因为一次基准可能跑好几分钟，HTTP 轮询既延迟又浪费。

---

## 3. 后端

### 3.1 进程与中间件管线

入口：`backend/src/index.ts`。顺序是有意为之：

| 顺序 | 中间件 | 为什么在这里 |
| --- | --- | --- |
| 1 | `dotenv`（根目录 `.env`） | 必须在任何模块读取 `process.env` 之前加载。 |
| 2 | 密钥重加密 | 把用内置默认密钥加密的 provider API key 重新加密，同步执行，先于流量。 |
| 3 | `trust proxy = 1` | 否则所有请求看起来都来自反向代理，登录限流会失效。 |
| 4 | `helmet`（显式 CSP） | `defaultSrc 'self'`；Ant Design 需要内联样式，因此放行。 |
| 5 | `cors` | 默认 `false`（同源）。仅当前后端不同域时才配 `CORS_ORIGIN`。 |
| 6 | `express.json({ limit: '10mb' })` | 大上限是为 base64 图片输入准备的。 |
| 7 | `/api/auth` 公开路由、`/api/health` | 唯二不需要认证的接口。 |
| 8 | `authMiddleware` + 受保护路由 | 其余全部。 |
| 9 | `/api` 兜底 | 返回 JSON 404，避免下面的 SPA 兜底用 HTML 响应 API 调用。 |
| 10 | 静态资源 + SPA 兜底 | 托管 `frontend/dist`，其余路径回落到 `index.html`。 |
| 11 | 错误处理器 | 把抛出的异常转成 JSON；没有它，一个 rejected promise 会让请求悬挂。 |

生命周期钩子：

- **启动** — `store.reconcileOrphans()`（见上文约束 1）。
- **关停** — 收到 `SIGTERM`/`SIGINT` 时把运行中的基准标记为 `interrupted`、关闭 HTTP 服务，
  并在 10 秒后强制退出，避免一条 keep-alive 连接卡住容器停止。

### 3.2 认证与授权

单管理员账号，基于 JWT。涉及 `routes/auth.ts`、`middleware/auth.ts`、`services/userStore.ts`。

- **初始化** — 首次启动时若 `users` 表为空，用 `AUTH_USERNAME` / `AUTH_PASSWORD` 创建管理员。若密码来自内置
  默认值（即未设置 `AUTH_PASSWORD`），则置 `password_change_required`，界面会在首次登录时强制改密。
- **登录** — `POST /api/auth/login`，bcrypt 比对，JWT 用 `getJwtSecret()` 签名（默认有效期 24 小时）。
  限流：**每 IP 5 分钟 5 次**。
- **令牌** — 普通调用用 `Authorization: Bearer <jwt>`。
- **一次性令牌** — `EventSource` 和普通下载无法设置请求头，所以客户端先调 `POST /api/auth/sse-token` 换取
  一次性 token，再以 `?token=` 传入；认证中间件只接受一次并随即销毁。
- **前端联动** — `apiFetch` 在 401 时派发 `auth-expired` 窗口事件；`App.tsx` 监听后清除 token 并跳转到
  `/login?returnTo=…`。

### 3.3 请求校验

`validation/middleware.ts` 用 Zod schema 包裹路由，并**替换** `req.body` 为解析结果
（`req.body = result.data`）。两点必须记牢：

- 响应格式统一：取第一条 Zod 错误信息，以 `{ error }` + HTTP 400 返回。
- **Zod 默认剥离未知字段。** 不在 schema 里的字段根本到不了 handler。因此给存储型 JSON 列加字段必须同时改
  schema——参见 §3.4 与 §12。

### 3.4 Provider 适配层

`providers/adapter.ts` 中的 `DynamicProvider` 用统一接口封装四种线上协议。早期的单厂商类
（`openai.ts`、`claude.ts`、`gemini.ts`、`zai.ts`）保留用于向后兼容，由
`benchmarkEngine.resolveProvider` 解析。

| 格式 | 端点形态 | 认证 | 流式 | 视觉输入 |
| --- | --- | --- | --- | --- |
| `openai` | `POST /chat/completions` | `Authorization: Bearer` | 支持 | URL + base64 |
| `anthropic` | `POST /messages` | `x-api-key`（含 `anthropic-beta`） | 支持 | 仅 base64 |
| `gemini` | `POST /models/{model}:generateContent` | `x-goog-api-key` 请求头 | 支持 | 仅 base64 |
| `custom` | `POST /chat/completions` | `Authorization: Bearer` | 支持 | URL + base64 |

- **生成参数** — `GenerationParams`（temperature、topP、topK、frequencyPenalty、presencePenalty、stop、
  seed、responseFormat）由 `openAIGenerationFields`、`anthropicGenerationFields`、`geminiGenerationFields`
  按格式映射；某格式不支持的字段直接丢弃，绝不伪造。
- **统一结果** — 每次调用返回 `LLMResponse`，含 `inputTokens`、`outputTokens`、`reasoningTokens`、
  `responseTime`、`firstTokenLatency`（**非流式时为 `null`，绝不估算**）、`estimatedCost`，以及 provider 未
  返回用量时的 `usageEstimated` 标记。
- **定价** — 唯一来源 `utils/modelPricing.ts`：每百万 token 单价、缓存读档位、最长前缀匹配模型名。适配器里
  不允许出现硬编码价格。
- **错误** — `utils/providerError.ts` 优先按 HTTP 状态码 / provider 错误码分类（`timeout`、`rate_limit`、
  `api_error`、`network`、`unknown`），字符串匹配只作兜底。可重试类别按指数退避重试，`AbortController` 负责
  超时中断。
- **连通性测试** — `testProviderConnection()` 返回延迟、TTFT、输出 token 数和响应预览，模型库的"测试连接"即调用它。`PROBE_TIMEOUT_MS` 为 90 秒。

### 3.5 基准测试引擎

`services/benchmarkEngine.ts`。针对一组 provider 执行单个任务。

**可调项**（`BenchmarkConfig`）：`concurrency`、`iterations`、`warmupRuns`、`maxTokens`、`streaming`、
`images`、`requestInterval` + `randomizeInterval`、`maxQps`、`targetCacheHitRate`。

- `concurrency` 在路由层被限制在 5000 以内；`maxQps` 由惰性补充的 `TokenBucket` 执行，防止大规模压测冲垮端点。
- `targetCacheHitRate` 按比例给请求注入 UUID 前缀，使前缀缓存行为可复现，而不是碰运气。
- 预热迭代先跑，不计入统计。

**测量可信度是硬性要求，不是加分项：**

| 保证 | 实现 |
| --- | --- |
| 无模拟结果 | provider 报错就抛出，不存在把失败变成"成功"的兜底路径。 |
| 不伪造 TTFT | 非流式返回 `firstTokenLatency: null`，界面显示 `N/A`。 |
| 分位数插值 | P50/P95/P99 采用线性插值，小样本不会让 P95 退化成最大值。 |
| 吞吐口径诚实 | `avgTokensPerSecond` = 输出 token 总数 ÷ 成功样本的总墙钟时间，而不是"比值的平均值"。 |
| 披露离散度 | 每个汇总都带 `stdDevResponseTime` 与 `cvResponseTime`。 |
| 重试可见 | 每次迭代记录 `retries` 与 `e2eTime`（含退避等待）；汇总暴露 `retryCount`、`retryRate`、`hasRetries`。 |
| 样本诚实 | `sampleSize` 与 `ttftSampleCount` 告诉读者数字背后有多少数据。 |

发出的事件：`progress`、`error`、`complete`、`done`。

### 3.6 工作流引擎

`services/workflowEngine.ts`。编排一组 provider 上的任务列表。

- 任务**串行**执行（`options.executionMode: 'sequential'`），任务间可配 `cooldownBetweenTasks`——并行会互相
  污染延迟测量。
- 每个任务自带 `BenchmarkConfig`，可面向全部或部分 provider。
- `stopOnFailure` 为真时，某任务失败即中止后续；取消则跳过剩余任务并把工作流标记为 `cancelled`。
- provider key 是复合形式（`configId:modelName`），由 `resolveProviderInfo()` 转成可读名称用于存储与展示。
- 完成时聚合出 `WorkflowSummary`：总时长、总成本、总 token、每个 provider 的 `WorkflowProviderSummary`
  （内含用于趋势图的 `perTaskMetrics`）。

状态流转：`draft → running → completed | failed | cancelled`。

### 3.7 模板库

`services/workflowTemplateStore.ts` + `services/templateSeed.ts`。数据库是唯一事实来源：内置模板以
`builtin = 1` 播撒进 `workflow_templates`，`GET /api/workflows/templates` 读的是 store 而非静态数组。

**模板任务是嵌套结构，这一点是硬约束：**

```ts
tasks: [{
  name, description?,
  config: { prompt, systemPrompt?, maxTokens, concurrency, iterations, streaming, … },
  providers?, tags?,
}]
```

`WorkflowTaskSchema` 要求 `config` 必须是对象，把 `prompt`/`maxTokens` 摊平到任务顶层会直接 400。
前端编辑器内部可以用扁平结构，但**任何发往后端或持久化的内容都必须是嵌套的**。

### 3.8 模型身份核验

`services/identityEngine.ts` + `services/identityProbes.ts`。系统不轻信模型名，而是给端点做指纹，并与采集到的
基线做比对。

| 层级 | 探针 | 观测对象 |
| --- | --- | --- |
| **T0 — 协议** | `protocol.modelEcho`、`protocol.invalidModelError`、`protocol.logprobsSupport`、`protocol.jsonModeSupport`、`protocol.cacheReplay` | 端点如何描述自己、支持哪些协议特性 |
| **T1 — 分词器** | `tokenizer.en`、`tokenizer.zh`、`tokenizer.code`、`tokenizer.emoji`、`tokenizer.constantOffset` | 固定文本的精确 prompt token 数——相当于分词器签名 |

一次运行同时给出 `verdict` 和 `score`，**刻意分开报告**：任一硬性闸门（hard gate）都压过加权分数，因为取
平均会让一个致命信号被十几个通过信号稀释。结论取值 `consistent | suspicious | mismatch | inconclusive |
error`；扣分规则为每个 `fail` 扣 40、每个 `warn` 扣 15，分词 token 数容差为 1（计费粒度差异不代表换了分词器）。

需要参照物的探针（`requiresBaseline`）在没有基线时报告 `skipped`，而不是猜一个结果。

### 3.9 质量评测

`services/qualityEngine.ts` + `services/graders/` + `services/qualityImport.ts`。回答第三个问题——**答得对不对**，与前两根支柱互补：基准/工作流回答「跑得多快多贵」，身份核验回答「是不是它自称的模型」。

**分三层判分，能用规则判的题绝不调用裁判模型**：

| 层 | 判分器 | 适用 | 单样本成本 | 可复现性 |
| --- | --- | --- | --- | --- |
| **L1 确定性** | `exact`、`contains`、`regex`、`numeric_tolerance`、`json_schema`、`multiple_choice`、`set_match` | 数学、信息抽取、结构化输出、选择题、格式遵循 | 0（纯本地） | 完全 |
| L2 LLM-as-Judge | 计划中 | 写作、翻译、摘要、开放问答 | 1 次裁判调用 | 近似 |
| L3 人工 | 计划中 | 校准集、争议样本抽查 | 人时 | 低 |

当前实现只交付 L1。判分器注册表在 `services/graders/index.ts`：新增判分器 = 加一个文件 + 注册一行，引擎不认识任何具体判分器。每个判分器满足统一契约
`(output, expected, config) => { status, score, detailKey, params, detail }`，并且**永不抛出**——判不出结果时返回 `status: 'error'`，由上层单独统计。`detailKey` 由前端用 i18n 渲染，`detail` 是同一信息的英文原文，导出文件里用的是它，因此翻译不会改变产物内容。

**三条硬约束**（均由契约测试锁死）：

1. **provider 抛错记为 `error`，绝不记 0 分**。接口 401 时报告显示 N 条 `error`、通过率为 `null`（界面显示「无法判定」），而不是一个「看起来合理」的 0%。
2. **`passRate = pass / (pass + fail)`**，分母剔除 `error`；没有任何可判定样本时返回 `null` 而不是 0。
3. **`quality_runs.dataset_snapshot` 在创建时冻结样本**，事后修改数据集不会改写历史报告。
4. **provider 返回 200 但内容为空 → `error`，不是答错**（`errorCategory: 'empty_response'`）。推理模型常把输出预算全花在思考上、
   答案还没生成就被截断；把这种情况记成「答错」等于把配置问题算到模型头上。当输出令牌数触及 `maxTokens` 时，
   判分依据会直接点名「输出预算耗尽」并提示调高该上限。默认 `maxTokens` 因此设为 4096 而非 1024——上限不计费，用不满即不花钱。

**测量条件显式固定**：默认 `temperature = 0` 且**非流式**（质量评测不测延迟，流式只增加失败面），同一轮评测内所有被测模型共用同一组参数。这些字段由
`DynamicProvider.execute()` 的第 7 个参数 `GenerationParams` 承载，**无需改造 Provider 适配层**。

**编排形态**：一个数据集 × 一个模型 = 一次 run；“体检报告”由前端串行发起 N 次 run 聚合而成。串行而非并行是刻意的——同时打六个数据集会把限流与排队混进质量结果，而那与模型质量无关。

**数据集**：内置 6 个数据集共 66 题。其中 GSM8K（20 题，MIT）与 HellaSwag（16 题，MIT）是上游原始题目的确定性抽样子集（`scripts/generate-quality-seed.py` 可重新生成），出处与完整许可声明见 `services/qualitySeed/ATTRIBUTION.md`；其余 4 个（结构化抽取、指令格式遵循、字段规范化、集合枚举，共 30 题）为本项目自建。TruthfulQA 因是生成式任务、字符串判分会产生误判而**刻意不收**；CMMLU 因 CC BY-NC-SA 4.0 与本项目 MIT 许可不兼容而**刻意不收**。用户可用 JSONL / CSV 导入自定义数据集，导入前返回行号级校验报告（`services/qualityImport.ts`），不合法的行不会被静默接受。

`qualitySeed.test.ts` 对全部 66 道题做自洽性检查：静态预检必须无问题、垃圾答案必须判为 `fail` 而非 `error`、参考答案必须判为 `pass`、每道自建正则题都有可命中的样例。手写判分规则最容易出的错是「正则写错导致所有模型恒错」——这种缺陷在真实运行里只会表现为「模型很差」，离线检查才能发现。

### 3.10 持久化层

`services/database.ts` 打开唯一 SQLite 连接（WAL 模式，5 秒 busy timeout），文件位于
`backend/data/benchmarks.db`。没有 ORM——每个 store 自己负责 `CREATE TABLE` 与 SQL。

各 store 结构一致：建表 → 全量读入内存 `Map` → 变更时写穿。schema 演进靠 `PRAGMA table_info` 探测加
幂等 `ALTER TABLE`，老库原地升级。

---

## 4. 前端

### 4.1 技术栈

| 层 | 技术 |
| --- | --- |
| 框架 | React 19 + TypeScript |
| 构建 | Vite 8 |
| 样式 | Tailwind CSS v4 + CSS 自定义属性 |
| UI 库 | Ant Design 6（浅色主题，`theme.defaultAlgorithm`） |
| 图表 | Recharts 3 |
| 动画 | Framer Motion 12 |
| 路由 | react-router-dom 7 |
| 国际化 | i18next 26 + react-i18next 17（中 / 英） |
| 分词 | js-tiktoken（真实 token 数，不用启发式） |
| 测试 | Vitest 4 + Testing Library |

### 4.2 路由与页面

| 路径 | 页面 | 用途 |
| --- | --- | --- |
| `/login` | 登录 | 登录凭据；首次登录强制改密 |
| `/workflow` | 工作流 | 配置并运行多任务基准；实时进度与结果 |
| `/history` | 历史记录 | 过往运行，支持删除 / 复制 / 重跑 |
| `/history/:id` | 运行详情 | 单次运行的图表与逐任务指标 |
| `/modules` | 模板库 | 可复用任务模板的增删改查 |
| `/modellibrary` | 模型库 | Provider 增删改、连接测试、按模型定价 |
| `/identity` | 模型身份 | 采集基线并核验端点 |
| `/quality` | 质量评测 | 单模型 × 多数据集的体检报告；逐题下钻与导出 |
| `/playground` | 竞技场 | 单提示词、流式、视觉输入、生成参数、历史侧栏 |

`App.tsx` 从 pathname 推导当前页面，用于顶栏标题与引导；`/history/:id` 由一个小包装组件承载，因为
`useParams()` 只能在匹配该路由的 `<Route element>` 内部取到值。

### 4.3 组件地图

| 组件 | 职责 |
| --- | --- |
| `App.tsx` | 路由、认证闸门、AntD 主题、页面引导 |
| `Sidebar.tsx` | 分组导航（测试 · 工具）、运行中标徽、退出登录 |
| `LoginPage.tsx` | 登录表单与强制改密 |
| `GuidedTour.tsx` | 基于 `data-tour` 锚点的聚光灯引导 |
| `WorkflowGuide.tsx` | `WorkflowStepper`（配置 → 运行 → 结果）与 `GettingStartedHero` |
| `WorkflowConfigPanel.tsx` | 配置主界面：基本信息、provider、模板、任务编辑器、成本汇总 |
| `WorkflowBasics.tsx` / `ProviderPicker.tsx` / `TemplateGallery.tsx` / `TaskEditor.tsx` | 配置面板各分区 |
| `WorkflowHeader.tsx` / `WorkflowProgress.tsx` / `WorkflowResults.tsx` | 运行生命周期三视图 |
| `ResultCharts.tsx` | 结果图表（Recharts） |
| `HistoryPanel.tsx` / `HistoryDetailPage.tsx` | 运行列表与详情 |
| `ModelLibraryPage.tsx` | Provider 管理 |
| `ModuleLibraryPage.tsx` | 模板管理 |
| `IdentityPage.tsx` | 身份核验界面 |
| `PlaygroundPage.tsx` / `PlaygroundHistorySidebar.tsx` | 交互式调试 |
| `AppFooter.tsx` / `Logo.tsx` / `LanguageSwitcher.tsx` | 外框组件 |

### 4.4 状态管理

没有全局状态库。每个领域各有一个 hook，由 `App.tsx` 组装：

| Hook | 负责 |
| --- | --- |
| `useAuth` | Token 状态、登录、登出、改密 |
| `useWorkflow` | 工作流列表、当前运行、模板、SSE 订阅、实时指标、刷新后重连 |
| `useProviders` | Provider 增删改与连接测试 |
| `useTemplates` | 模板增删改（含嵌套负载转换） |
| `usePlayground` | 提示词执行、流式、中断、指标 |
| `usePlaygroundHistory` | 竞技场历史记录 |
| `useIdentity` | 探针、基线、核验运行 |
| `useLocale` | i18n + AntD locale 对象 |

`services/api.ts` 是唯一了解 token 的地方：`apiFetch` 附加 Bearer 头，401 时抛出 `auth-expired`；
`sseUrl()` 与 `downloadUrl()` 负责换取一次性 token。

### 4.5 主题与设计令牌

界面为浅色主题。AntD 令牌在 `App.tsx` 中一次性声明（品牌蓝 `#2563eb`、中性灰、8px 圆角），并与
`index.css` 里的 CSS 自定义属性保持一致，使手写的 Tailwind 类名与 AntD 组件呈现同一套视觉语言。组件统一从
`antdImports.ts` 导入 AntD 符号，便于控制打包。

### 4.6 国际化

只有两个资源文件：`i18n/en.json` 与 `i18n/zh.json`。语言按 `localStorage`（`llm-radar:locale`）→ 浏览器
顺序探测，回退到英文。测试会断言两份文件的 key 完全一致且非空——**新增文案必须两个文件都加**。

### 4.7 新手引导

`GuidedTour.tsx` 是自研的聚光灯引导，每一步对应页面元素上的 `data-tour` 属性。引导是**页面级而非全局**：
触发按钮放在页面头部（或首屏 hero）里，不放顶栏。首次运行状态按引导分别存储
（`uni-llm-bench.tour.v1`、`uni-llm-bench.tour.identity.v1`），既能再次打开，又不会每次访问都弹。

### 4.8 Token 计数与成本预估

`utils/tokenCount.ts` 封装 js-tiktoken 得到真实 token 数。`utils/costEstimate.ts` 把它与模型库里配置的单价
结合：输入 token 按 `inputPrice` 计价，其中预期命中前缀缓存的部分（由 `targetCacheHitRate` 决定）按
`cacheReadPrice` 计价。这是运行前的预估，因此 `cacheWritePrice` 目前只存不用。

---

## 5. 数据模型

共 10 张表，均由各自的 store 按需创建。

### `users`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `username` | TEXT UNIQUE | 由 `AUTH_USERNAME` 初始化 |
| `password_hash` | TEXT | bcrypt |
| `password_change_required` | INTEGER | 使用默认密码初始化时为 1 |
| `created_at` / `updated_at` | TEXT | ISO 时间戳 |

### `providers`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `name` | TEXT | 显示名 |
| `endpoint` | TEXT | 接口基址 |
| `api_key_encrypted` | TEXT | AES-256 静态加密 |
| `format` | TEXT | `openai` / `anthropic` / `gemini` / `custom` |
| `models` | TEXT (JSON) | `ModelConfig[]` |
| `created_at` / `updated_at` | TEXT | ISO 时间戳 |

### `benchmarks`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `bench_xxxxxxxx` |
| `status` | TEXT | pending / running / completed / failed / interrupted |
| `providers` | TEXT (JSON) | provider key 数组 |
| `config` | TEXT (JSON) | `BenchmarkConfig` |
| `results` | TEXT (JSON) | 每个 provider 的 `ProviderResult` |
| `capability_tests` | TEXT (JSON) | 可选 |
| `created_at` / `completed_at` | TEXT | ISO 时间戳 |

### `workflows`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `wf_xxxxxxxx` |
| `name` / `description` | TEXT | |
| `status` | TEXT | draft / running / completed / failed / cancelled |
| `providers` | TEXT (JSON) | provider key 数组 |
| `provider_labels` | TEXT (JSON) | key → 显示名 |
| `tasks` | TEXT (JSON) | `WorkflowTask[]`（`config` 嵌套） |
| `options` | TEXT (JSON) | `WorkflowOptions` |
| `task_results` | TEXT (JSON) | 默认 `[]` |
| `summary` | TEXT (JSON) | 完成时聚合 |
| `created_at` / `updated_at` / `started_at` / `completed_at` | TEXT | ISO 时间戳 |

### `workflow_templates`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | |
| `name` / `description` | TEXT | |
| `tasks` | TEXT (JSON) | 每个任务的 `config` 嵌套 |
| `options` | TEXT (JSON) | |
| `builtin` | INTEGER | 1 = 内置模板，用户不可改 |
| `created_at` / `updated_at` | TEXT | ISO 时间戳 |

### `fingerprint_baselines`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | |
| `provider_key` | TEXT | `configId:modelName` |
| `provider_name` / `model_name` | TEXT | 显示值 |
| `fingerprint` | TEXT (JSON) | probeId → 观测值 |
| `note` | TEXT | 可选 |
| `captured_at` | TEXT | ISO 时间戳 |

### `identity_runs`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | |
| `target` / `target_label` | TEXT | 被测端点 |
| `baseline_id` / `baseline_label` | TEXT | 参照基线（可选） |
| `status` | TEXT | pending / running / completed / failed |
| `probes` | TEXT (JSON) | `IdentityProbeResult[]` |
| `verdict` | TEXT | consistent / suspicious / mismatch / inconclusive / error |
| `score` | INTEGER | 0–100，与 verdict 分开报告 |
| `hard_gates` | TEXT (JSON) | 命中的硬性闸门 id |
| `summary` | TEXT (JSON) | pass / warn / fail / error / skipped 计数 |
| `created_at` / `completed_at` / `error` | TEXT | |

### `playground_history`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | |
| `provider_id` / `provider_name` / `model_name` | TEXT | |
| `prompt` / `system_prompt` | TEXT | |
| `max_tokens` | INTEGER | |
| `use_streaming` / `enable_thinking` | INTEGER | 开关位 |
| `response_text` / `reasoning_text` | TEXT | |
| `metrics` | TEXT (JSON) | 延迟、TTFT、token、成本 |
| `gen_params` | TEXT (JSON) | 生成参数（新增列） |
| `error` | TEXT | |
| `created_at` | TEXT | ISO 时间戳 |
### `quality_datasets`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 内置为 `builtin:<slug>`，用户创建为 `ds_xxxxxxxx` |
| `name` / `description` | TEXT | |
| `source` | TEXT | builtin / import / manual |
| `samples` | TEXT (JSON) | `QualitySample[]`（题目、参考答案、判分器与其配置） |
| `sample_count` | INTEGER | 冗余计数，列表接口无需解析 JSON |
| `tags` | TEXT (JSON) | |
| `note` | TEXT | 出处与许可说明，界面与导出中原文展示 |
| `builtin` | INTEGER | 1 = 内置，用户不可改不可删 |
| `created_at` / `updated_at` | TEXT | ISO 时间戳 |

### `quality_runs`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `qr_xxxxxxxx` |
| `name` / `description` | TEXT | |
| `status` | TEXT | pending / running / completed / failed / cancelled / interrupted |
| `dataset_id` / `dataset_name` | TEXT | 名字冗余，数据集被删后历史仍可读 |
| `dataset_snapshot` | TEXT (JSON) | **创建时冻结的样本**，之后再不被更新 |
| `targets` | TEXT (JSON) | `configId:modelName` 数组 |
| `target_labels` | TEXT (JSON) | key → 显示名 |
| `params` | TEXT (JSON) | temperature / maxTokens / concurrency / repeats |
| `results` | TEXT (JSON) | 每个 target 的 `QualityTargetSummary`，含逐题明细 |
| `progress` | TEXT (JSON) | `{ completed, total, currentTarget }` |
| `created_at` / `started_at` / `completed_at` / `error` | TEXT | |

---

## 6. API 参考

所有路由均以 `/api` 为前缀，除标注外都需要 Bearer JWT。

### 认证

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| POST | `/auth/login` | 公开（5 分钟 5 次） | 登录，返回 JWT |
| GET | `/auth/verify` | 需要 | 校验 token 并返回 `passwordChangeRequired` |
| POST | `/auth/change-password` | 需要 | 改密（至少 6 位，且不能与原密码相同） |
| POST | `/auth/sse-token` | 需要 | 换取用于 SSE / 下载的一次性 token |
| GET | `/health` | 公开 | 存活探针 |

### Provider

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/providers` | 列表（API key 掩码） |
| POST | `/providers` | 新建 |
| GET | `/providers/:id` | 查询 |
| PUT | `/providers/:id` | 更新 |
| DELETE | `/providers/:id` | 删除 |
| POST | `/providers/:id/test` | 测试已保存的 provider |
| POST | `/providers/test-connection` | 保存前测试 |

### 基准测试

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/benchmarks` | 启动一次基准 |
| GET | `/benchmarks?limit&offset` | 列表（默认 200，上限 500） |
| GET | `/benchmarks/:id` | 查询 |
| GET | `/benchmarks/:id/stream` | SSE 进度 |
| GET | `/benchmarks/:id/export` | 导出 JSON / CSV |
| POST | `/benchmarks/:id/cancel` | 取消 |

### 工作流

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/workflows` | 创建并启动工作流 |
| GET | `/workflows` | 列表 |
| GET | `/workflows/active` | 当前运行中的工作流（用于重连） |
| GET | `/workflows/templates` | 全部模板（内置 + 自定义） |
| GET | `/workflows/:id` | 查询（剥离 API key） |
| GET | `/workflows/:id/stream` | SSE 进度 |
| PATCH | `/workflows/:id` | 更新名称 / 描述 |
| POST | `/workflows/:id/cancel` | 取消 |
| GET | `/workflows/:id/export` | 导出结果 |
| POST | `/workflows/:id/duplicate` | 复制配置 |
| DELETE | `/workflows/:id` | 删除 |

### 模板

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/templates` | 内置 + 自定义模板列表 |
| POST | `/templates` | 新建自定义模板 |
| PUT | `/templates/:id` | 更新自定义模板 |
| DELETE | `/templates/:id` | 删除自定义模板 |

### 竞技场（`/playground`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/playground/run` | 非流式请求 |
| POST | `/playground/stream` | SSE 流式请求 |
| GET | `/playground/history` | 历史列表 |
| GET | `/playground/history/:id` | 单条历史 |
| DELETE | `/playground/history/:id` | 删除单条 |
| DELETE | `/playground/history` | 清空 |

### 模型身份

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/identity/probes` | 探针目录（层级、分组、成本、是否需基线） |
| GET | `/identity/baselines` | 基线列表 |
| POST | `/identity/baselines` | 为 `configId:modelName` 采集基线 |
| DELETE | `/identity/baselines/:id` | 删除基线 |
| POST | `/identity/verify` | 对照（可选）基线执行核验 |
| GET | `/identity/runs` | 历史核验记录 |
| GET | `/identity/runs/:id` | 单条核验 |
| DELETE | `/identity/runs/:id` | 删除核验 |

### 质量评测

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/quality/graders` | 判分器目录（是否需要参考答案、可配字段） |
| GET | `/quality/datasets` | 数据集列表（不含样本，只带题数） |
| GET | `/quality/datasets/:id` | 数据集详情（含样本） |
| POST | `/quality/datasets` | 新建（手工） |
| PUT | `/quality/datasets/:id` | 更新（内置数据集拒绝，403） |
| DELETE | `/quality/datasets/:id` | 删除（内置数据集拒绝，403） |
| POST | `/quality/datasets/import` | 导入 JSONL / CSV，返回逐行校验报告；`persist: false` 为仅校验 |
| POST | `/quality/estimate` | 跑前成本预估（含假设说明） |
| POST | `/quality/runs` | 创建并启动评测，任意 target 无法解析时直接 400 而不消耗令牌 |
| GET | `/quality/runs` | 历史列表（分页，默认 100 上限 500） |
| GET | `/quality/runs/:id` | 单次运行详情 |
| GET | `/quality/runs/:id/stream` | SSE 实时进度 |
| POST | `/quality/runs/:id/cancel` | 中止 |
| GET | `/quality/runs/:id/export` | 导出 JSON / CSV |
| DELETE | `/quality/runs/:id` | 删除（运行中拒绝，400） |


---

## 7. 实时（SSE）契约

所有流都发送 `data: <json>\n\n` 帧。

| 流 | 事件类型 |
| --- | --- |
| `GET /api/benchmarks/:id/stream` | `progress`、`error`、`complete`、`done` |
| `GET /api/workflows/:id/stream` | `workflow:init`、`task:start`、`task:progress`、`task:complete`、`task:error`、`cooldown`、`workflow:complete` |
| `POST /api/playground/stream` | `chunk`、`reasoning`、`error`、`done`，以字面量 `[DONE]` 帧收尾 |
| `GET /api/quality/runs/:id/stream` | `quality:init`、`quality:progress`、`quality:target`、`quality:complete`、`quality:error` |

工作流流在建立连接时会补发一次携带当前快照的 `workflow:init`；若运行已结束则立即发
`workflow:complete`——这正是刷新页面后能重连的原因。

---

## 8. 安全

| 关注点 | 机制 |
| --- | --- |
| 访问控制 | 所有受保护路由校验 JWT；单管理员账号 |
| 密码存储 | `users.password_hash` 存 bcrypt 哈希 |
| 默认凭据 | 使用默认密码初始化时，首次登录强制改密 |
| 暴力破解 | 登录限流每 IP 5 分钟 5 次；配置 `trust proxy` 使限流按真实客户端生效 |
| API key 静态存储 | AES-256 加密，密钥由 `scrypt(secret, salt)` 派生；按需解密，永不返回客户端（只返回掩码） |
| 密钥管理 | `JWT_SECRET` / `ENCRYPTION_SECRET` / `ENCRYPTION_SALT` 优先读环境变量，否则生成一次并以 `0600` 权限持久化到 `backend/data`；识别并警告遗留的硬编码默认值 |
| 响应头 | `helmet` 显式 CSP；CORS 默认关闭 |
| SSE / 下载 | 使用一次性 token，避免长期 token 出现在 URL 里 |
| 错误暴露 | 统一 JSON 错误处理器，不向客户端回传堆栈 |

威胁模型：可信网络内自托管的单用户工具。它不是多租户系统，也没有按用户的授权层——若要对外暴露，请自行在
反向代理上终止 TLS。

---

## 9. 配置与部署

仓库根目录单个 `.env`：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3001` | HTTP 端口 |
| `AUTH_USERNAME` | `admin` | 初始管理员用户名 |
| `AUTH_PASSWORD` | `changeme` | 初始密码（首次登录强制修改） |
| `JWT_SECRET` | 自动生成 | JWT 签名密钥 |
| `JWT_EXPIRES_IN` | `24h` | token 有效期 |
| `ENCRYPTION_SECRET` / `ENCRYPTION_SALT` | 自动生成 | API key 加密输入 |
| `CORS_ORIGIN` | 未设置（同源） | 跨主机 UI 允许的来源 |

部署方式：

1. **脚本** — `./start.sh` 安装依赖、构建前后端并运行 `backend/dist/index.js`。
2. **Docker** — 多阶段 Alpine 镜像（`zj-unicom-ai/uni-llm-bench`），非 root 运行；`docker-compose.yml` 挂载
   `./data`，使 SQLite 文件与生成的密钥在重启后保留。
3. **开发** — 后端 3001（nodemon + tsx），前端 5173（Vite 代理）。

由于状态集中在一个 SQLite 文件和 `backend/data` 下几个密钥文件里，备份就是复制文件。

---

## 10. 测试

前后端都用 Vitest。重点覆盖：

- **后端** — 认证中间件与路由（含一次性 token）、加密与密钥管理、provider 适配器行为与缓存、校验 schema、
  store 同步、工作流引擎（单元 / 执行 / 集成）。
- **前端** — 各 hook（`useWorkflow`、`useProviders`、`usePlayground`、`useAuth`）、页面（`IdentityPage`、`QualityReport`、
  `QualitySampleTable`、`QualityRunForm`）、工具函数（`costEstimate`、`tokenCount`、`demo`），以及一个 **i18n 一致性测试**：
  `en.json` 与 `zh.json` 一旦不同步即失败。
- **质量评测** — 判分器逐个边界用例（46）、导入解析（17）、引擎契约（16）、路由（23）、内置数据集自洽性（14）。
  前端另有 15 例覆盖报告渲染的同一契约：`passRate` 为 `null` 时必须显示「无法判定」，绝不显示 0%。

契约测试固定住 §3.5 的测量可信度保证，例如：当 provider 抛错时 `executeWithRetry` 必须 reject——这样后续
的改动不可能悄悄把模拟结果加回来。§3.9 的质量评测沿用同一思路：provider 抛错时该样本必须记为 `error`
且通过率为 `null`，`error` 不得被折算成 0 分。

---

## 11. 项目结构

```
uni-llm-bench/
├── backend/
│   └── src/
│       ├── index.ts              # Express 入口、中间件顺序、生命周期
│       ├── types.ts              # 领域类型
│       ├── middleware/auth.ts    # JWT + 一次性 token
│       ├── routes/               # auth · providers · benchmarks · workflows
│       │                         # templates · playground · identity
│       ├── services/             # 引擎、调度器、各 store
│       │   ├── benchmarkEngine.ts   workflowEngine.ts
│       │   ├── identityEngine.ts    identityProbes.ts
│       │   └── *_store.ts           按聚合持久化
│       ├── providers/            # DynamicProvider + 早期厂商类
│       ├── utils/                # encryption · secrets · modelPricing
│       │                         # providerError · csv
│       └── validation/           # zod schema + validate() 中间件
├── frontend/
│   └── src/
│       ├── App.tsx               # 路由、认证闸门、AntD 主题、引导
│       ├── components/           # 页面与共享组件
│       ├── hooks/                # 按领域的状态
│       ├── services/api.ts       # fetch 封装、一次性 token
│       ├── i18n/                 # en.json · zh.json · 一致性测试
│       ├── utils/                # tokenCount · costEstimate · demo
│       └── data/                 # 长上下文合成语料（1k–256k，项目自研）
├── design/
│   ├── DESIGN.md                 # 本文（中文）
│   └── DESIGN-en.md              # 英文版
├── docs/screenshots/             # README 配图
├── Dockerfile · docker-compose.yml · start.sh
└── README.md · CHANGELOG.md · CONTRIBUTING.md · SECURITY.md（中文）· 对应英文版 *-en.md
```

---
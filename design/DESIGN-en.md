# Uni LLM Bench — Design Document

> Version: v0.0.1 · Last updated: 2026-09-10
> 中文版本: [DESIGN.md](./DESIGN.md)

## Table of Contents

- [1. Overview](#1-overview)
- [2. Architecture](#2-architecture)
- [3. Backend](#3-backend)
  - [3.1 Process and Middleware Pipeline](#31-process-and-middleware-pipeline)
  - [3.2 Authentication and Authorization](#32-authentication-and-authorization)
  - [3.3 Request Validation](#33-request-validation)
  - [3.4 Provider Adapter Layer](#34-provider-adapter-layer)
  - [3.5 Benchmark Engine](#35-benchmark-engine)
  - [3.6 Workflow Engine](#36-workflow-engine)
  - [3.7 Template Library](#37-template-library)
  - [3.8 Model Identity Verification](#38-model-identity-verification)
  - [3.9 Persistence Layer](#39-persistence-layer)
- [4. Frontend](#4-frontend)
  - [4.1 Tech Stack](#41-tech-stack)
  - [4.2 Routes and Pages](#42-routes-and-pages)
  - [4.3 Component Map](#43-component-map)
  - [4.4 State Management](#44-state-management)
  - [4.5 Theme and Design Tokens](#45-theme-and-design-tokens)
  - [4.6 Internationalization](#46-internationalization)
  - [4.7 Guided Tour](#47-guided-tour)
  - [4.8 Token Counting and Cost Estimation](#48-token-counting-and-cost-estimation)
- [5. Data Model](#5-data-model)
- [6. API Reference](#6-api-reference)
- [7. Real-time (SSE) Contract](#7-real-time-sse-contract)
- [8. Security](#8-security)
- [9. Configuration and Deployment](#9-configuration-and-deployment)
- [10. Testing](#10-testing)
- [11. Project Structure](#11-project-structure)
- [12. Known Gaps and Notes](#12-known-gaps-and-notes)

---

## 1. Overview

Uni LLM Bench is a self-hosted Web application for measuring and comparing LLM API endpoints. Users register Providers (OpenAI, Anthropic, Google Gemini, or any OpenAI-compatible gateway), orchestrate multi-task benchmark Workflows, and read results through latency percentiles, throughput, cost, and cross-model rankings. It also answers a question that pure speed-testing tools cannot: *is the Model behind this endpoint actually the one it claims to be?*

**Capability matrix**

| Capability | Entry point | Supporting module |
| --- | --- | --- |
| Multi-task benchmark Workflow | `/workflow` | `services/workflowEngine.ts` + `services/benchmarkEngine.ts` |
| Run history, detail charts, export | `/history`, `/history/:id` | `services/workflowStore.ts`, `utils/csv.ts` |
| Reusable task Templates | `/modules` | `services/workflowTemplateStore.ts`, `services/templateSeed.ts` |
| Provider and Model registration | `/modellibrary` | `services/providerStore.ts`, `routes/providers.ts` |
| Model Identity verification | `/identity` | `services/identityEngine.ts`, `services/identityProbes.ts` |
| Interactive single-prompt debugging | `/playground` | `routes/playground.ts`, `services/playgroundHistoryStore.ts` |
---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                           Browser                             │
│  React 19 · Ant Design 6 · Recharts · Tailwind CSS v4        │
│  i18next(zh/en)· Framer Motion                                │
└──────────────────────────────┬───────────────────────────────┘
                               │ REST（Bearer JWT） · SSE（one-time token）
┌──────────────────────────────▼───────────────────────────────┐
│                        Express service                           │
│  ┌───────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ helmet /  │  │ auth middleware    │  │ zod validate              │  │
│  │ CORS      │  │              │  │ req.body = parsed result    │  │
│  └─────┬─────┘  └──────┬───────┘  └───────────┬───────────┘  │
│        └───────────────┴──────────────────────┘              │
│                         │                                    │
│  ┌──────────────────────▼─────────────────────────────────┐  │
│  │                      route layer                            │  │
│  │  auth · providers · benchmarks · workflows · templates │  │
│  │  playground · identity                                   │  │
│  └──────────────────────┬─────────────────────────────────┘  │
│  ┌──────────────────────▼─────────────────────────────────┐  │
│  │                      service layer                            │  │
│  │  benchmarkEngine · workflowEngine · identityEngine     │  │
│  │  capabilityTester · stores（in-memory Map + SQLite write-through）    │  │
│  │  stores（in-memory Map + SQLite write-through）                       │  │
│  └──────────────────────┬─────────────────────────────────┘  │
│  ┌──────────────────────▼─────────────────────────────────┐  │
│  │                   Provider adapter                      │  │
│  │  DynamicProvider：openai · anthropic · gemini · custom  │  │
│  └──────────────────────┬─────────────────────────────────┘  │
└─────────────────────────┼────────────────────────────────────┘
                          │
              ┌───────────▼────────────┐
              │ SQLite (better-sqlite3)│
              │ WAL mode · single file       │
              └────────────────────────┘
```

Everything runs inside a **single Node.js process**: no Redis, no queue, no external database. In production, Vite compiles the frontend into static assets served by Express; in development, the Vite dev server (port 5173) proxies `/api` to the backend (port 3001).

This yields two constraints that run through the entire system design:

1. **In-progress tasks exist only in memory.** A running benchmark is held in the store's `Map`. If the process dies, that run can never finish — so at startup, leftover `running` records are reconciled to `interrupted` rather than letting the UI spin forever.
2. **Long tasks push via streaming rather than polling.** Progress reaches the browser over SSE, because a single benchmark may run for minutes, and HTTP polling is both laggy and wasteful.

---

## 3. Backend

### 3.1 Process and Middleware Pipeline

Entry point: `backend/src/index.ts`. The order is intentional:

| Order | Middleware | Why here |
| --- | --- | --- |
| 1 | `dotenv` (root `.env`) | Must be loaded before any module reads `process.env`. |
| 2 | Key re-encryption | Re-encrypts provider API keys that were encrypted with the built-in default key; runs synchronously, ahead of traffic. |
| 3 | `trust proxy = 1` | Otherwise every request appears to come from the reverse proxy and login rate limiting breaks. |
| 4 | `helmet` (explicit CSP) | `defaultSrc 'self'`; Ant Design needs inline styles, so they are allowed. |
| 5 | `cors` | Defaults to `false` (same-origin). Set `CORS_ORIGIN` only when frontend and backend are on different domains. |
| 6 | `express.json({ limit: '10mb' })` | The large limit is for base64 image input. |
| 7 | `/api/auth` public route, `/api/health` | The only two endpoints that require no authentication. |
| 8 | `authMiddleware` + protected routes | Everything else. |
| 9 | `/api` catch-all | Returns a JSON 404, preventing the SPA fallback below from answering API calls with HTML. |
| 10 | Static assets + SPA fallback | Serves `frontend/dist`; all other paths fall back to `index.html`. |
| 11 | Error handler | Converts thrown exceptions into JSON; without it, a rejected promise would leave the request hanging. |

Lifecycle hooks:

- **Startup** — `store.reconcileOrphans()` (see constraint 1 above).
- **Shutdown** — on `SIGTERM`/`SIGINT`, marks running benchmarks as `interrupted`, closes the HTTP server, and force-exits after 10 seconds to avoid a single keep-alive connection stalling container stop.

### 3.2 Authentication and Authorization

A single admin account, based on JWT. Involves `routes/auth.ts`, `middleware/auth.ts`, `services/userStore.ts`.

- **Initialization** — on first start, if the `users` table is empty, an admin is created from `AUTH_USERNAME` / `AUTH_PASSWORD`. If the password comes from the built-in default (i.e. `AUTH_PASSWORD` is not set), `password_change_required` is set, and the UI forces a password change on first login.
- **Login** — `POST /api/auth/login`, bcrypt comparison, JWT signed with `getJwtSecret()` (default validity 24 hours). Rate limit: **5 attempts per IP per 5 minutes**.
- **Token** — normal calls use `Authorization: Bearer <jwt>`.
- **One-time token** — `EventSource` and plain downloads cannot set request headers, so the client first calls `POST /api/auth/sse-token` to obtain a one-time token, then passes it via `?token=`; the auth middleware accepts it only once and destroys it immediately.
- **Frontend integration** — `apiFetch` dispatches the `auth-expired` window event on 401; `App.tsx` listens, clears the token, and redirects to `/login?returnTo=…`.

### 3.3 Request Validation

`validation/middleware.ts` wraps routes with Zod schema and **replaces** `req.body` with the parsed result (`req.body = result.data`). Two points to remember:

- Uniform response format: takes the first Zod error message and returns it as `{ error }` + HTTP 400.
- **Zod strips unknown fields by default.** Fields not in the schema never reach the handler. Therefore, adding a field to a stored JSON column must be done together with changing the schema — see §3.4 and §12.

### 3.4 Provider Adapter Layer

`DynamicProvider` in `providers/adapter.ts` wraps four live protocols behind a unified interface. The early single-vendor classes (`openai.ts`, `claude.ts`, `gemini.ts`, `zai.ts`) are retained for backward compatibility and resolved by `benchmarkEngine.resolveProvider`.

| Format | Endpoint shape | Auth | Streaming | Vision input |
| --- | --- | --- | --- | --- |
| `openai` | `POST /chat/completions` | `Authorization: Bearer` | Supported | URL + base64 |
| `anthropic` | `POST /messages` | `x-api-key` (incl. `anthropic-beta`) | Supported | base64 only |
| `gemini` | `POST /models/{model}:generateContent` | `x-goog-api-key` header | Supported | base64 only |
| `custom` | `POST /chat/completions` | `Authorization: Bearer` | Supported | URL + base64 |

- **Generation parameters** — `GenerationParams` (temperature, topP, topK, frequencyPenalty, presencePenalty, stop, seed, responseFormat) are mapped per format by `openAIGenerationFields`, `anthropicGenerationFields`, `geminiGenerationFields`; fields unsupported by a format are dropped outright — never faked.
- **Unified result** — every call returns an `LLMResponse` containing `inputTokens`, `outputTokens`, `reasoningTokens`, `responseTime`, `firstTokenLatency` (**`null` when non-streaming, never estimated**), `estimatedCost`, and a `usageEstimated` flag when the provider does not return usage.
- **Pricing** — single source of truth is `utils/modelPricing.ts`: per-million-token unit price, cache-read tiers, and longest-prefix model-name matching. Hard-coded prices are not allowed in the adapters.
- **Errors** — `utils/providerError.ts` classifies primarily by HTTP status code / provider error code (`timeout`, `rate_limit`, `api_error`, `network`, `unknown`); string matching is only a fallback. Retryable categories are retried with exponential backoff, and `AbortController` handles timeout interruption.
- **Connectivity test** — `testProviderConnection()` returns latency, TTFT, output token count, and a response preview; the Model Library's "Test connection" calls it. `PROBE_TIMEOUT_MS` is 90 seconds.

### 3.5 Benchmark Engine

`services/benchmarkEngine.ts`. Executes a single task against a set of providers.

**Tunables** (`BenchmarkConfig`): `concurrency`, `iterations`, `warmupRuns`, `maxTokens`, `streaming`, `images`, `requestInterval` + `randomizeInterval`, `maxQps`, `targetCacheHitRate`.

- `concurrency` is capped at 5000 at the route layer; `maxQps` is enforced by a lazily-refilled `TokenBucket` to prevent large-scale benchmarks from overwhelming the endpoint.
- `targetCacheHitRate` injects UUID prefixes into requests proportionally, making prefix cache hit-rate behavior reproducible rather than left to chance.
- Warm-up iterations run first and are excluded from statistics.

**Measurement credibility is a hard requirement, not a nice-to-have:**

| Guarantee | Implementation |
| --- | --- |
| No simulated results | errors from the provider are thrown; there is no fallback path that turns a failure into a "success". |
| No faked TTFT | non-streaming returns `firstTokenLatency: null` and the UI shows `N/A`. |
| Percentile interpolation | P50/P95/P99 use linear interpolation, so small samples do not degenerate P95 into the maximum value. |
| Honest throughput | `avgTokensPerSecond` = total output tokens ÷ total wall-clock time of successful samples, not the "average of ratios". |
| Disclose dispersion | every summary carries `stdDevResponseTime` and `cvResponseTime`. |
| Retries visible | each iteration records `retries` and `e2eTime` (including backoff waits); the summary exposes `retryCount`, `retryRate`, `hasRetries`. |
| Honest sample size | `sampleSize` and `ttftSampleCount` tell the reader how much data backs the numbers. |

Events emitted: `progress`, `error`, `complete`, `done`.

### 3.6 Workflow Engine

`services/workflowEngine.ts`. Orchestrates a task list across a set of providers.

- Tasks run **sequentially** (`options.executionMode: 'sequential'`), with an optional `cooldownBetweenTasks` between them — parallelism would cross-contaminate latency measurements.
- Each task carries its own `BenchmarkConfig` and can target all or a subset of providers.
- When `stopOnFailure` is true, a failed task aborts the rest; a cancellation skips remaining tasks and marks the workflow `cancelled`.
- The provider key is composite (`configId:modelName`) and is converted to a human-readable name by `resolveProviderInfo()` for storage and display.
- On completion it aggregates a `WorkflowSummary`: total duration, total cost, total tokens, and a `WorkflowProviderSummary` per provider (containing `perTaskMetrics` for trend charts).

State flow: `draft → running → completed | failed | cancelled`.

### 3.7 Template Library

`services/workflowTemplateStore.ts` + `services/templateSeed.ts`. The database is the single source of truth: built-in templates are seeded into `workflow_templates` with `builtin = 1`, and `GET /api/workflows/templates` reads from the store rather than a static array.

**Template tasks use a nested structure — this is a hard constraint:**

```ts
tasks: [{
  name, description?,
  config: { prompt, systemPrompt?, maxTokens, concurrency, iterations, streaming, … },
  providers?, tags?,
}]
```

`WorkflowTaskSchema` requires `config` to be an object; flattening `prompt`/`maxTokens` onto the task top level results in a direct 400. The frontend editor may use a flat structure internally, but **anything sent to the backend or persisted must be nested**.

### 3.8 Model Identity Verification

`services/identityEngine.ts` + `services/identityProbes.ts`. The system does not trust the model name; instead it fingerprints the endpoint and compares it against a collected baseline.

| Tier | Probe | Observed object |
| --- | --- | --- |
| **T0 — protocol** | `protocol.modelEcho`, `protocol.invalidModelError`, `protocol.logprobsSupport`, `protocol.jsonModeSupport`, `protocol.cacheReplay` | how the endpoint describes itself and which protocol features it supports |
| **T1 — tokenizer** | `tokenizer.en`, `tokenizer.zh`, `tokenizer.code`, `tokenizer.emoji`, `tokenizer.constantOffset` | exact prompt token count for fixed text — effectively a tokenizer signature |

A run reports both a `verdict` and a `score`, **deliberately reported separately**: any hard gate overrides the weighted score, because averaging would let one fatal signal be diluted by a dozen passing ones. The conclusion takes the value `consistent | suspicious | mismatch | inconclusive | error`; the deduction rule is −40 per `fail` and −15 per `warn`, with a tokenizer token-count tolerance of 1 (billing-granularity differences do not mean the tokenizer changed).

Probes that need a reference (`requiresBaseline`) report `skipped` when no baseline exists, rather than guessing a result.

### 3.9 Persistence Layer

`services/database.ts` opens the single SQLite connection (WAL mode, 5-second busy timeout), located at `backend/data/benchmarks.db`. There is no ORM — each store is responsible for its own `CREATE TABLE` and SQL.

All stores share the same structure: create table → load fully into an in-memory `Map` → write-through on change. Schema evolution relies on `PRAGMA table_info` probing plus idempotent `ALTER TABLE`, so old databases upgrade in place.

---

## 4. Frontend

### 4.1 Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | React 19 + TypeScript |
| Build | Vite 8 |
| Styling | Tailwind CSS v4 + CSS custom properties |
| UI library | Ant Design 6 (light theme, `theme.defaultAlgorithm`) |
| Charts | Recharts 3 |
| Animation | Framer Motion 12 |
| Routing | react-router-dom 7 |
| i18n | i18next 26 + react-i18next 17 (zh / en) |
| Tokenization | js-tiktoken (real token counts, no heuristics) |
| Testing | Vitest 4 + Testing Library |

### 4.2 Routes and Pages

| Path | Page | Purpose |
| --- | --- | --- |
| `/login` | Login | credentials; forced password change on first login |
| `/workflow` | Workflow | configure and run multi-task benchmarks; live progress and results |
| `/history` | History | past runs, with delete / duplicate / rerun |
| `/history/:id` | Run detail | charts and per-task metrics for a single run |
| `/modules` | Template Library | CRUD for reusable task templates |
| `/modellibrary` | Model Library | provider CRUD, connection test, per-model pricing |
| `/identity` | Model Identity | collect baselines and verify endpoints |
| `/playground` | Arena | single prompt, streaming, vision input, generation parameters, history sidebar |

`App.tsx` derives the current page from the pathname, used for the top bar title and guided tour; `/history/:id` is carried by a small wrapper component because `useParams()` can only read values inside the matching `<Route element>`.

### 4.3 Component Map

| Component | Responsibility |
| --- | --- |
| `App.tsx` | routing, auth gate, AntD theme, page guided tour |
| `Sidebar.tsx` | grouped navigation (Tests · Tools), running badge, logout |
| `LoginPage.tsx` | login form and forced password change |
| `GuidedTour.tsx` | spotlight guided tour based on `data-tour` anchors |
| `WorkflowGuide.tsx` | `WorkflowStepper` (configure → run → results) and `GettingStartedHero` |
| `WorkflowConfigPanel.tsx` | main configuration screen: basics, provider, templates, task editor, cost summary |
| `WorkflowBasics.tsx` / `ProviderPicker.tsx` / `TemplateGallery.tsx` / `TaskEditor.tsx` | sections of the configuration panel |
| `WorkflowHeader.tsx` / `WorkflowProgress.tsx` / `WorkflowResults.tsx` | the three views of the run lifecycle |
| `ResultCharts.tsx` | result charts (Recharts) |
| `HistoryPanel.tsx` / `HistoryDetailPage.tsx` | run list and detail |
| `ModelLibraryPage.tsx` | provider management |
| `ModuleLibraryPage.tsx` | template management |
| `IdentityPage.tsx` | identity verification UI |
| `PlaygroundPage.tsx` / `PlaygroundHistorySidebar.tsx` | interactive debugging |
| `AppFooter.tsx` / `Logo.tsx` / `LanguageSwitcher.tsx` | chrome components |

### 4.4 State Management

There is no global state library. Each domain has its own hook, assembled by `App.tsx`:

| Hook | Responsibility |
| --- | --- |
| `useAuth` | token state, login, logout, password change |
| `useWorkflow` | workflow list, current run, templates, SSE subscription, live metrics, reconnect after refresh |
| `useProviders` | provider CRUD and connection test |
| `useTemplates` | template CRUD (including nested payload transform) |
| `usePlayground` | prompt execution, streaming, abort, metrics |
| `usePlaygroundHistory` | Arena history |
| `useIdentity` | probes, baselines, verification runs |
| `useLocale` | i18n + AntD locale object |

`services/api.ts` is the only place that knows about the token: `apiFetch` attaches the Bearer header and throws `auth-expired` on 401; `sseUrl()` and `downloadUrl()` handle exchanging for a one-time token.

### 4.5 Theme and Design Tokens

The UI uses a light theme. AntD tokens are declared once in `App.tsx` (brand blue `#2563eb`, neutral gray, 8px radius) and kept consistent with the CSS custom properties in `index.css`, so hand-written Tailwind classes and AntD components share one visual language. Components import AntD symbols uniformly from `antdImports.ts` to keep the bundle controlled.

### 4.6 Internationalization

There are only two resource files: `i18n/en.json` and `i18n/zh.json`. Language is detected in order from `localStorage` (`llm-radar:locale`) → browser, falling back to English. Tests assert that the two files have exactly the same non-empty keys — **any new copy must be added to both files**.

### 4.7 Guided Tour

`GuidedTour.tsx` is a custom spotlight guided tour where each step maps to a page element's `data-tour` attribute. The tour is **page-scoped, not global**: the trigger button lives in the page header (or the first-screen hero), not the top bar. First-run state is stored separately per tour (`uni-llm-bench.tour.v1`, `uni-llm-bench.tour.identity.v1`), so it can be reopened without popping up on every visit.

### 4.8 Token Counting and Cost Estimation

`utils/tokenCount.ts` wraps js-tiktoken to obtain real token counts. `utils/costEstimate.ts` combines this with the unit prices configured in the Model Library: input tokens are priced at `inputPrice`, and the portion expected to hit the prefix cache (determined by `targetCacheHitRate`) is priced at `cacheReadPrice`. This is a pre-run estimate, so `cacheWritePrice` is currently stored but unused.

---

## 5. Data Model

There are 8 tables in total, each created on demand by its own store.

### `users`

| Column | Type | Description |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `username` | TEXT UNIQUE | initialized from `AUTH_USERNAME` |
| `password_hash` | TEXT | bcrypt |
| `password_change_required` | INTEGER | 1 when initialized with the default password |
| `created_at` / `updated_at` | TEXT | ISO timestamp |

### `providers`

| Column | Type | Description |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `name` | TEXT | display name |
| `endpoint` | TEXT | API base URL |
| `api_key_encrypted` | TEXT | AES-256 static encryption |
| `format` | TEXT | `openai` / `anthropic` / `gemini` / `custom` |
| `models` | TEXT (JSON) | `ModelConfig[]` |
| `created_at` / `updated_at` | TEXT | ISO timestamp |

### `benchmarks`

| Column | Type | Description |
| --- | --- | --- |
| `id` | TEXT PK | `bench_xxxxxxxx` |
| `status` | TEXT | pending / running / completed / failed / interrupted |
| `providers` | TEXT (JSON) | provider key array |
| `config` | TEXT (JSON) | `BenchmarkConfig` |
| `results` | TEXT (JSON) | the `ProviderResult` per provider |
| `capability_tests` | TEXT (JSON) | optional |
| `created_at` / `completed_at` | TEXT | ISO timestamp |

### `workflows`

| Column | Type | Description |
| --- | --- | --- |
| `id` | TEXT PK | `wf_xxxxxxxx` |
| `name` / `description` | TEXT | |
| `status` | TEXT | draft / running / completed / failed / cancelled |
| `providers` | TEXT (JSON) | provider key array |
| `provider_labels` | TEXT (JSON) | key → display name |
| `tasks` | TEXT (JSON) | `WorkflowTask[]` (`config` nested) |
| `options` | TEXT (JSON) | `WorkflowOptions` |
| `task_results` | TEXT (JSON) | defaults to `[]` |
| `summary` | TEXT (JSON) | aggregated on completion |
| `created_at` / `updated_at` / `started_at` / `completed_at` | TEXT | ISO timestamp |

### `workflow_templates`

| Column | Type | Description |
| --- | --- | --- |
| `id` | TEXT PK | |
| `name` / `description` | TEXT | |
| `tasks` | TEXT (JSON) | each task's `config` nested |
| `options` | TEXT (JSON) | |
| `builtin` | INTEGER | 1 = built-in template, not user-editable |
| `created_at` / `updated_at` | TEXT | ISO timestamp |

### `fingerprint_baselines`

| Column | Type | Description |
| --- | --- | --- |
| `id` | TEXT PK | |
| `provider_key` | TEXT | `configId:modelName` |
| `provider_name` / `model_name` | TEXT | display value |
| `fingerprint` | TEXT (JSON) | probeId → observed value |
| `note` | TEXT | optional |
| `captured_at` | TEXT | ISO timestamp |

### `identity_runs`

| Column | Type | Description |
| --- | --- | --- |
| `id` | TEXT PK | |
| `target` / `target_label` | TEXT | tested endpoint |
| `baseline_id` / `baseline_label` | TEXT | reference baseline (optional) |
| `status` | TEXT | pending / running / completed / failed |
| `probes` | TEXT (JSON) | `IdentityProbeResult[]` |
| `verdict` | TEXT | consistent / suspicious / mismatch / inconclusive / error |
| `score` | INTEGER | 0–100, reported separately from the verdict |
| `hard_gates` | TEXT (JSON) | ids of the hard gates that fired |
| `summary` | TEXT (JSON) | counts of pass / warn / fail / error / skipped |
| `created_at` / `completed_at` / `error` | TEXT | |

### `playground_history`

| Column | Type | Description |
| --- | --- | --- |
| `id` | TEXT PK | |
| `provider_id` / `provider_name` / `model_name` | TEXT | |
| `prompt` / `system_prompt` | TEXT | |
| `max_tokens` | INTEGER | |
| `use_streaming` / `enable_thinking` | INTEGER | flag bit |
| `response_text` / `reasoning_text` | TEXT | |
| `metrics` | TEXT (JSON) | latency, TTFT, token, cost |
| `gen_params` | TEXT (JSON) | generation parameters (added column) |
| `error` | TEXT | |
| `created_at` | TEXT | ISO timestamp |
---

## 6. API Reference

All routes are prefixed with `/api` and require a Bearer JWT unless noted.

### Auth

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/login` | public (5 per IP per 5 min) | login, returns JWT |
| GET | `/auth/verify` | required | verifies token and returns `passwordChangeRequired` |
| POST | `/auth/change-password` | required | change password (at least 6 chars, and must differ from the old one) |
| POST | `/auth/sse-token` | required | exchange for a one-time token used for SSE / downloads |
| GET | `/health` | public | liveness probe |

### Provider

| Method | Path | Description |
| --- | --- | --- |
| GET | `/providers` | list (API key masked) |
| POST | `/providers` | create |
| GET | `/providers/:id` | read |
| PUT | `/providers/:id` | update |
| DELETE | `/providers/:id` | delete |
| POST | `/providers/:id/test` | test a saved provider |
| POST | `/providers/test-connection` | test before saving |

### Benchmark

| Method | Path | Description |
| --- | --- | --- |
| POST | `/benchmarks` | start a benchmark |
| GET | `/benchmarks?limit&offset` | list (default 200, max 500) |
| GET | `/benchmarks/:id` | read |
| GET | `/benchmarks/:id/stream` | SSE progress |
| GET | `/benchmarks/:id/export` | export JSON / CSV |
| POST | `/benchmarks/:id/cancel` | cancel |

### Workflow

| Method | Path | Description |
| --- | --- | --- |
| POST | `/workflows` | create and start a workflow |
| GET | `/workflows` | list |
| GET | `/workflows/active` | currently running workflow (for reconnect) |
| GET | `/workflows/templates` | all templates (built-in + custom) |
| GET | `/workflows/:id` | read (API key stripped) |
| GET | `/workflows/:id/stream` | SSE progress |
| PATCH | `/workflows/:id` | update name / description |
| POST | `/workflows/:id/cancel` | cancel |
| GET | `/workflows/:id/export` | export results |
| POST | `/workflows/:id/duplicate` | duplicate configuration |
| DELETE | `/workflows/:id` | delete |

### Template

| Method | Path | Description |
| --- | --- | --- |
| GET | `/templates` | built-in + custom template list |
| POST | `/templates` | create custom template |
| PUT | `/templates/:id` | update custom template |
| DELETE | `/templates/:id` | delete custom template |

### Arena (`/playground`)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/playground/run` | non-streaming request |
| POST | `/playground/stream` | SSE streaming request |
| GET | `/playground/history` | history list |
| GET | `/playground/history/:id` | single history entry |
| DELETE | `/playground/history/:id` | delete one entry |
| DELETE | `/playground/history` | clear all |

### Model Identity

| Method | Path | Description |
| --- | --- | --- |
| GET | `/identity/probes` | probe catalog (tier, group, cost, needs baseline) |
| GET | `/identity/baselines` | baseline list |
| POST | `/identity/baselines` | collect a baseline for `configId:modelName` |
| DELETE | `/identity/baselines/:id` | delete baseline |
| POST | `/identity/verify` | run verification against an (optional) baseline |
| GET | `/identity/runs` | verification history |
| GET | `/identity/runs/:id` | single verification |
| DELETE | `/identity/runs/:id` | delete verification |

---

## 7. Real-time (SSE) Contract

All streams send `data: <json>\n\n` frames.

| Stream | Event types |
| --- | --- |
| `GET /api/benchmarks/:id/stream` | `progress`, `error`, `complete`, `done` |
| `GET /api/workflows/:id/stream` | `workflow:init`, `task:start`, `task:progress`, `task:complete`, `task:error`, `cooldown`, `workflow:complete` |
| `POST /api/playground/stream` | `chunk`, `reasoning`, `error`, `done`, ending with a literal `[DONE]` frame |

The workflow stream replays a `workflow:init` carrying the current snapshot when a connection is established; if the run has already finished it immediately sends `workflow:complete` — this is exactly why a page refresh can reconnect.

---

## 8. Security

| Concern | Mechanism |
| --- | --- |
| Access control | all protected routes verify the JWT; single admin account |
| Password storage | `users.password_hash` stores the bcrypt hash |
| Default credentials | when initialized with the default password, a forced password change is required on first login |
| Brute force | login rate limit is 5 per IP per 5 minutes; configuring `trust proxy` makes rate limiting apply to the real client |
| Static API key storage | AES-256 encryption, key derived via `scrypt(secret, salt)`; decrypted on demand and never returned to the client (only a mask is returned) |
| Secret management | `JWT_SECRET` / `ENCRYPTION_SECRET` / `ENCRYPTION_SALT` are read from environment variables first, otherwise generated once and persisted to `backend/data` with `0600` permissions; legacy hardcoded defaults are detected and warned about |
| Response headers | `helmet` with explicit CSP; CORS off by default |
| SSE / download | one-time tokens are used to avoid long-lived tokens appearing in URLs |
| Error exposure | unified JSON error handler; stacks are not returned to the client |

Threat model: a single-user, self-hosted tool inside a trusted network. It is not a multi-tenant system and has no per-user authorization layer — if you expose it publicly, terminate TLS at your reverse proxy yourself.

---

## 9. Configuration and Deployment

A single `.env` at the repository root:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port |
| `AUTH_USERNAME` | `admin` | initial admin username |
| `AUTH_PASSWORD` | `changeme` | initial password (forced change on first login) |
| `JWT_SECRET` | auto-generated | JWT signing key |
| `JWT_EXPIRES_IN` | `24h` | token validity |
| `ENCRYPTION_SECRET` / `ENCRYPTION_SALT` | auto-generated | API key encryption inputs |
| `CORS_ORIGIN` | unset (same-origin) | origins allowed for a cross-host UI |

Deployment options:

1. **Script** — `./start.sh` installs dependencies, builds the frontend and backend, and runs `backend/dist/index.js`.
2. **Docker** — a multi-stage Alpine image (`zj-unicom-ai/uni-llm-bench`), running non-root; `docker-compose.yml` mounts `./data` so the SQLite file and generated secrets survive restarts.
3. **Development** — backend on 3001 (nodemon + tsx), frontend on 5173 (Vite proxy).

Because state is concentrated in a single SQLite file and a few secret files under `backend/data`, backup is just copying the files.

---

## 10. Testing

Both frontend and backend use Vitest. Key coverage areas:

- **Backend** — auth middleware and routes (including one-time tokens), encryption and secret management, provider adapter behavior and caching, validation schema, store synchronization, workflow engine (unit / execution / integration).
- **Frontend** — each hook (`useWorkflow`, `useProviders`, `usePlayground`, `useAuth`), pages (`IdentityPage`), utilities (`costEstimate`, `tokenCount`, `demo`), and an **i18n consistency test**: `en.json` and `zh.json` fail the moment they drift out of sync.

Contract tests lock in the measurement-credibility guarantees from §3.5 — for example, `executeWithRetry` must reject when the provider throws an error, so future changes cannot silently reintroduce simulated results.

---

## 11. Project Structure

```
uni-llm-bench/
├── backend/
│   └── src/
│       ├── index.ts              # Express entry, middleware order, lifecycle
│       ├── types.ts              # domain types
│       ├── middleware/auth.ts    # JWT + one-time token
│       ├── routes/               # auth · providers · benchmarks · workflows
│       │                         # templates · playground · identity
│       ├── services/             # engines, scheduler, stores
│       │   ├── benchmarkEngine.ts   workflowEngine.ts
│       │   ├── identityEngine.ts    identityProbes.ts
│       │   └── *_store.ts           persistence by aggregate
│       ├── providers/            # DynamicProvider + legacy vendor classes
│       ├── utils/                # encryption · secrets · modelPricing
│       │                         # providerError · csv
│       └── validation/           # zod schema + validate() middleware
├── frontend/
│   └── src/
│       ├── App.tsx               # routing, auth gate, AntD theme, guided tour
│       ├── components/           # pages and shared components
│       ├── hooks/                # domain-scoped state
│       ├── services/api.ts       # fetch wrapper, one-time token
│       ├── i18n/                 # en.json · zh.json · consistency test
│       ├── utils/                # tokenCount · costEstimate · demo
│       └── data/                 # ShareGPT prompt corpus (1k–256k)
├── design/
│   ├── DESIGN.md                 # this document (Chinese)
│   └── DESIGN-en.md              # English version
├── docs/screenshots/             # README figures
├── Dockerfile · docker-compose.yml · start.sh
└── README.md · CHANGELOG.md · CONTRIBUTING.md · SECURITY.md (Chinese) · corresponding English version *-en.md
```

---

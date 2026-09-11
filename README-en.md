[中文](README.md) | **English**

# Uni LLM Bench

**A self-hosted, lightweight LLM API benchmarking platform — model fingerprint comparison + model quality evaluation.**

Benchmark any OpenAI-compatible endpoint from inside your own network, use fingerprint comparison to verify whether the endpoint is really the model it claims to be, and use deterministic graders to evaluate whether those answers are actually right. One Node.js process plus one SQLite file — no external services required.

---

## Core positioning

| Keyword | In one line |
|---|---|
| 🏠 **Self-hosted** | The whole stack runs on your own machine: no Redis, no Postgres, no telemetry; the app itself has zero external dependencies and can be deployed in an isolated network |
| 🪶 **Lightweight** | One Node.js process plus one SQLite file; up and running with a one-line script or Docker Compose, and a backup is just that one file |
| 🕵️ **Model fingerprint comparison** | 10 fingerprint probes collected across two layers, compared item by item against a trusted baseline, and decided by hard criteria (consistent / suspicious / mismatch) |
| 🧭 **Model quality evaluation** | 7 deterministic graders + 6 built-in datasets (66 questions) answer the question performance numbers cannot: is the answer actually right? |

---

## Why Uni LLM Bench?

Uni LLM Bench makes "trustworthy" the default out of the box, rather than a toggle you have to validate afterward:

- **Numbers don't lie** — As soon as an API errors out, it is thrown honestly; reports are never padded with "looks reasonable" simulated data. Metrics that can't be measured are left blank — never faked with a coefficient. Every millisecond and every cent you see was really run.
- **Model fingerprint comparison — confirm you're actually calling that model** — Model Identity uses a baseline comparison of 10 fingerprint probes across two layers (protocol layer + tokenizer layer), giving you an unambiguous "yes / no" rather than a similarity score open to interpretation.
- **Model quality evaluation — someone grades whether it's right** — 7 deterministic graders run entirely locally: zero cost, fully reproducible; anything a rule cannot judge is reported as unjudgeable, never counted as wrong.
- **Know the cost before you run** — Configure a model's unit price once, and every Workflow shows a cost estimation before you press "Start" (including the savings from cache hits), so you're never surprised by the bill afterward.
- **Self-hosted + lightweight — truly yours** — A single process plus a single-file database, with no Redis, no Postgres, and no telemetry reporting. Your data stays on your own machine, and the architecture is simple enough that you can fix it yourself when something breaks.

---

## Highlights

| | |
|---|---|
| 🔬 **Measurement trustworthiness** | Every value is real and traceable: fail loud, never leave simulated values, show N/A when unmeasurable, count retries in latency, structurally classify errors |
| 🧪 **Workflow engine** | Multi-task serial benchmark, each task with its own prompt / concurrency (1–5000) / iterations (1–10M), with warm-up |
| 💰 **Cost estimation** | Per-model unit price per million tokens, including cache read tiers, with estimated cost visible before running |
| 📚 **Template Library** | 20 built-in templates + full CRUD for custom templates, persistently stored |
| ⚔️ **Arena** | Two Providers/Models face off on the same prompt, with streaming side-by-side response comparison |
| 🎨 **Zero-dependency onboarding** | Self-built spotlight-style guided tour, status-following Workflow step bar, bilingual (Chinese/English) |

---

## Features

### Workflow engine

- Multi-task serial execution; each task can be individually configured with its own prompt, concurrency, and iteration count
- concurrency 1–5000, iterations 1–10M, warm-up 0–5, max tokens 50–32000
- Cooldown between tasks, randomized interval jitter, global QPS token bucket
- Configurable prefix cache hit rate, so cache behavior is reproducible rather than left to chance
- Stop on failure, override Provider selection per task
- SSE real-time progress: you can switch to another page after starting, and progress syncs back live

### Model fingerprint comparison (Model Identity)

This module **never asks for the label — it fingerprints the endpoint and compares it item by item against a baseline**, landing on a definite yes / no.

- **T0 · Protocol-layer probes** — Model name echo, illegal-model error shape, logprobs support, JSON mode support, prefix cache replay detection
- **T1 · Tokenizer probes** — How the endpoint tokenizes fixed probe text (English / Chinese / code / emoji) exposes its underlying tokenizer
- **Baseline mechanism** — First collect a fingerprint from an endpoint you trust (preferably the vendor's official API); all verification is relative to the baseline
- **Hard criteria** — Conclusion is one of: `consistent` / `suspicious` / `mismatch` / `undetermined` / `error`; one fatal signal takes priority over any weighted score
- **Evidence table** — Each probe lists its baseline and measured values, so you can verify the conclusion yourself

### Model quality evaluation

Answers the third question — **is it right**. Together with the performance benchmark (how fast and how expensive) and model fingerprint comparison (is it the model it claims to be), it closes the loop on model evaluation.

- **7 deterministic graders** — exact match, keyword containment, regex format, numeric tolerance, JSON Schema, multiple choice, set match. All run locally: zero cost, fully reproducible
- **A question a rule can grade never reaches a judge model** — a judge is both an expense and a bias source, so it is reserved for subjective tasks (L2, planned)
- **6 built-in datasets, 66 questions** — GSM8K (math reasoning, MIT) and HellaSwag (commonsense continuation, MIT) come from the upstream originals; four authored datasets cover structured extraction, instruction format, field normalisation and set enumeration
- **Unmeasurable is never counted as wrong** — when the provider errors or a grader has nothing to compare, the question is recorded as unjudgeable and excluded from the pass-rate denominator; if nothing at all was judgeable the rate reads "not judgeable" rather than 0%
- **Every question is reviewable** — raw model output, reference answer, matched rule and its evidence values are kept, filterable down to failures or unjudgeable samples
- **Frozen snapshots** — questions are fixed when a run starts, so editing a dataset later cannot rewrite a historical report
- **Measurement conditions are on the report** — temperature, max tokens, concurrency and the grader mix are disclosed up front; temperature 0 and non-streaming by default, for reproducibility
- **JSONL / CSV import** — validated row by row before import, with a line-numbered report; an invalid row is never silently accepted

| Metric | Meaning |
| --- | --- |
| Pass rate | pass / (pass + fail); unjudgeable questions stay out of the denominator |
| Pass rate by category | broken down by question type, which is where weak spots show |
| Unjudgeable count | provider errors or uncomparable questions, shown next to the pass rate rather than in a footnote |
| Avg latency / cost | reuses the existing statistical conventions, and only over samples that actually returned a response |

### Model Library

- Unified management of Providers and Models: endpoints, API keys (encrypted storage), model capabilities
- Four formats: OpenAI, Anthropic, Google Gemini, and generic OpenAI-compatible (DeepSeek, Mistral, Ollama, vLLM, etc.)
- Optional model unit price (input / output / cache read / cache write, per million tokens) to drive cost estimation
- "Test connection" available to validate configuration

### Template Library

- 20 built-in templates, shipped with the library: smoke test, TTFT latency profiling, output throughput gradient and concurrency ladder, streaming comparison batch,
  long-context throughput, cost-effectiveness audit, reliability and stability, and load mixes close to real business (knowledge Q&A, long-text summarization,
  code generation, information extraction, function calling and structured output, creative writing, text translation, multi-turn dialogue, Chinese RAG and hallucination resistance,
  mathematical reasoning, multimodal vision benchmark, real-traffic mix)
- Full CRUD for custom templates with persistence
- One-click load a template into the Workflow form

### Arena

- Two Providers/Models compared side by side on the same prompt, with responses shown in parallel
- Both streaming and non-streaming modes, with image URL or upload support to test multimodal models
- Each request shows token count, TTFT, tokens per second, and response time; history is kept in the sidebar

### History and export

- Fully persistent run history and complete result details
- Side-by-side comparison of multiple runs, drill-down per entry
- Export as JSON or CSV

### Authentication and security

- JWT login, configurable credentials; first login forces a password change
- JWT / encryption key / encryption salt auto-generated and persisted; no hardcoded defaults
- Login rate limiting (5 attempts / 5 minutes), Helmet security headers, and CSP
- SSE and download links use one-time tokens; JWT does not appear in the query string
- token stored in `sessionStorage`, cleared when the tab is closed
- CORS restricted to configured origins (same-origin by default)

### Internationalization and onboarding

- Complete bilingual (Chinese/English) interface
- Zero-dependency spotlight-style guided tour (based on `data-tour` anchors), auto-pops on first entry, reopenable from any page at any time
- Workflow step bar (Configure → Run → Result) that auto-advances following the real run state

---

## Measurement trustworthiness

The core design goal is to eliminate the fatal flaw of "measurement tools returning untrustworthy data." Below are the guarantees already in place, several of which are structurally locked down by contract tests:

| Guarantee | Specific meaning |
|---|---|
| **No simulated-data fallback** | All `simulateResponse()` / `simulateLatency()` have been removed. A provider error is thrown, never turned into a "success" result. Contract tests assert that `executeWithRetry` **must** reject when the provider throws. |
| **No fabricated TTFT** | Non-streaming responses return `firstTokenLatency: null` instead of hard-computing `response time × 0.3`; the UI shows N/A. |
| **Linear-interpolated quantiles** | P50/P95/P99 use linear interpolation, so P95 no longer collapses to the max value on small samples. |
| **Honest throughput scope** | `avgTokensPerSecond` is computed over the total wall-clock time of successful samples, not the "average of ratios" (the latter systematically overestimates). |
| **Disclosed dispersion** | Every run carries `stdDevResponseTime` and `cvResponseTime` (coefficient of variation). |
| **Retries counted in** | Records retry count and `e2eTime` including backoff waits; summaries expose `retryRate` and `hasRetries`. |
| **Structurally classified errors** | Classified first by HTTP status code / provider error code, with string matching only as fallback — so 429 is retried while 4xx is not. |
| **Single source of pricing** | Unified pricing module (per-million unit price, cache tiers, longest-prefix match) supplies all data; no scattered magic numbers in the adapters. |
| **Bounded and recoverable** | List endpoints are paginated (default 200, max 500); on startup and graceful shutdown, leftover `running` tasks are corrected to `interrupted`. |

---

## Metrics

| Metric | Description |
| --- | --- |
| Response time | Average / P50 / P95 / P99 (linear interpolation) |
| Standard deviation / coefficient of variation | Standard deviation and coefficient of variation |
| Token speed | Input, output tokens per second (aggregated by wall-clock time) |
| TTFT | First-token latency — available only for streaming, otherwise N/A |
| Throughput | Requests per second under concurrency pressure |
| Success rate | Ratio of successful vs. failed requests, with `retryRate` |
| Cost estimation | Per-model cost breakdown based on configured unit price, including cache tiers |
| Quality pass rate | dataset-driven per-question grading; unjudgeable questions stay out of the denominator (see Model quality evaluation) |

---

## Screenshots

<table>
  <tr>
    <td align="center"><b>Workflow — Configure and Run</b></td>
    <td align="center"><b>Model Fingerprint Comparison — Verification</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/screenshot-workflow.png" width="500" /></td>
    <td><img src="docs/screenshots/screenshot-identity.png" width="500" /></td>  </tr>
  <tr>
    <td align="center"><b>Arena — Same-prompt Showdown</b></td>
    <td align="center"><b>Run Details — Charts</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/screenshot-playground.png" width="500" /></td>
    <td><img src="docs/screenshots/screenshot-detail.png" width="500" /></td>
  </tr>
  <tr>
    <td align="center"><b>Model Quality Evaluation — Model Health Check</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/screenshot-quality.png" width="500" /></td>
  </tr>
</table>

## Quick Start

The payoff of **self-hosted + lightweight** is that there is nothing to provision first: no Redis, no Postgres, no object storage, and no sign-up with any third party. All you need is Node.js 20+ (or Docker) to have the complete platform running on your own machine.

### Option 1: One-line script (production)

```bash
git clone https://github.com/zj-unicom-ai/uni-llm-bench.git
cd uni-llm-bench
cp .env.example .env    # edit .env to set credentials
chmod +x start.sh && ./start.sh
```

### Option 2: Docker Compose (production)

```bash
git clone https://github.com/zj-unicom-ai/uni-llm-bench.git
cd uni-llm-bench
cp .env.example .env    # edit .env to set credentials
docker compose up -d
```

### Option 3: Development mode

```bash
git clone https://github.com/zj-unicom-ai/uni-llm-bench.git
cd uni-llm-bench
cp .env.example .env

# Backend — http://localhost:3001
cd backend && npm install && npm run dev &

# Frontend — http://localhost:5173
cd ../frontend && npm install && npm run dev
```

In production, the frontend build is served by Express on port 3001 — open `http://localhost:3001`; in development, open
`http://localhost:5173` (Vite proxies API requests to the backend).

### Configuration

All configuration lives in a single `.env` file at the project root:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Service port |
| `AUTH_USERNAME` | `admin` | Login username |
| `AUTH_PASSWORD` | `changeme` | Login password (must be changed on first login) |
| `JWT_SECRET` | Auto-generated | JWT signing key (auto-generated if left empty) |
| `JWT_EXPIRES_IN` | `24h` | JWT validity period |
| `ENCRYPTION_SECRET` | Auto-generated | API key encryption key (auto-generated if left empty) |
| `CORS_ORIGIN` | Same-origin only | Allowed CORS origins (e.g. `https://your-domain.com`) |

### Connect a real Provider

1. Log in with your credentials
2. Go to **Model Library**
3. Click **Add Provider**
4. Select a format (OpenAI / Anthropic / Gemini / OpenAI-compatible)
5. Fill in the endpoint and API key
6. Click **Test connection** to validate
7. Optional: fill in the model unit price (per million tokens) to enable cost estimation

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                           Browser                         │
│   React 19 · Ant Design 6 · Recharts · Tailwind CSS v4   │
└───────────────────────────┬──────────────────────────────┘
                            │ REST / SSE
┌───────────────────────────▼──────────────────────────────┐
│                       Express Server                      │
│  ┌───────────┐  ┌────────────┐  ┌─────────────────────┐  │
│  │ Auth      │  │ REST API   │  │ SSE stream          │  │
│  │ (JWT)     │  │ /api/*     │  │ /workflows/:id      │  │
│  └───────────┘  └─────┬──────┘  └──────────┬──────────┘  │
│                       │                    │             │
│  ┌────────────────────▼────────────────────▼───────────┐ │
│  │                      Service layer                  │ │
│  │  Benchmark engine · Workflow engine · Templates     │ │
│  │  Fingerprint engine · Quality engine                │ │
│  └────────────────────┬────────────────────────────────┘ │
│                       │                                  │
│  ┌────────────────────▼────────────────────────────────┐ │
│  │                  Provider adapters                   │ │
│  │  OpenAI · Anthropic · Gemini · OpenAI-compatible      │ │
│  └────────────────────┬────────────────────────────────┘ │
└───────────────────────┼──────────────────────────────────┘
                        │
           ┌────────────▼─────────────┐
           │ SQLite (better-sqlite3)  │
           │ single-file database     │
           └──────────────────────────┘
```

The entire stack runs in a **single Node.js process** — **self-hosted**: no Redis, no Postgres, no external dependencies and no telemetry; **lightweight**: one process and one database file is the entire runtime footprint. Vite compiles the frontend into static files served by Express; SQLite (WAL mode) stores benchmarks, workflows, templates, identity baselines, and Provider config in a single file, so backing up is just copying that file.

| Layer | Tech stack |
|---|---|
| Frontend | React 19, Vite 8, TypeScript, Tailwind CSS v4 |
| UI | Ant Design 6, Recharts, Framer Motion |
| Backend | Node.js, Express 4, TypeScript |
| Auth | JWT (jsonwebtoken + bcryptjs) |
| Storage | SQLite (better-sqlite3, raw SQL, no ORM) |
| Deployment | Docker (multi-stage Alpine, non-root) / shell script |

### Project structure

```
├── backend/
│   └── src/
│       ├── providers/     # Provider adapters (OpenAI, Anthropic, Gemini, etc.)
│       ├── routes/        # API route handlers
│       ├── services/      # Benchmark / Workflow / Identity engine and stores
│       ├── middleware/    # Auth
│       ├── utils/         # Keys, encryption, pricing, error classification
│       └── validation/    # Zod schema
├── frontend/
│   └── src/
│       ├── components/    # UI components and pages
│       ├── hooks/         # Data-fetching hooks
│       ├── i18n/          # en.json / zh.json (kept in sync, validated by tests)
│       ├── services/      # API client
│       ├── utils/         # token counting, cost estimation, demo mode
│       └── data/          # long-context synthetic prompt corpus (1k–256k, project-authored)
├── design/                # Design docs (Chinese & English)
├── docs/screenshots/      # README images
├── docker-compose.yml
├── Dockerfile
└── start.sh
```

---

## Documentation

- [Design document](design/DESIGN-en.md) — Architecture, data model, API reference, SSE contract

## Upstream project
| Project                                                    | Description |
|------------------------------------------------------------|------|
| [llm-api-bench](https://github.com/idemerge/llm-api-bench) | Original project base |

## Contributing

See [CONTRIBUTING-en.md](CONTRIBUTING-en.md) for development setup, code conventions, and the PR process; see [SECURITY-en.md](SECURITY-en.md) for security issues.

## License

[MIT](LICENSE)

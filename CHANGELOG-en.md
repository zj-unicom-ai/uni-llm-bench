[中文](CHANGELOG.md) | **English**

# Changelog

## [v0.0.1] - 2026-09-10

**Uni LLM Bench** — the first release: a self-hosted LLM API performance benchmark, cost estimation, and Model Identity verification platform. A single Node.js process, a single SQLite file, with no external dependency services.

### Added

**Template Library**

- **20 built-in templates** are written on database initialization: smoke test, latency profiling, throughput and concurrency gradient, streaming vs. batch comparison, long context, cost audit, reliability, plus real business workloads (knowledge Q&A, long-text summarization, code generation, information extraction, function calling, creative writing, text translation, multi-turn dialogue, RAG, mathematical reasoning, and multimodal vision benchmark)
- Custom templates support full CRUD, with one-click loading into the Workflow form

**Model Identity**

- **10 fingerprint probes** across two tiers — T0 protocol layer (model echo, error shape for invalid models, logprobs support, JSON mode, prefix cache replay detection) and T1 tokenizer layer (how fixed probe text is segmented under English / Chinese / code / emoji)
- Baseline fingerprints are taken from an endpoint you trust; the verdict is produced by a **hard decision gate** (`consistent` / `suspicious` / `mismatch` / `inconclusive` / `error`), where any fatal signal outweighs any weighted total score
- An evidence table lists the baseline and measured values for each probe

**Arena**

- Two provider/model combinations are compared head-to-head under the same prompt, with streaming and non-streaming support, and visual input via image URL or upload
- Per-request token count, TTFT, tokens/sec, and response time; recent runs are saved in the history sidebar

**Guided Tour**

- A zero-dependency spotlight guided tour based on `data-tour` anchors; it starts automatically on first visit and can be reopened from any page

### Changed

- Light glass-card UI
- The sidebar is grouped into **Testing** (Workflow, History, Template Library, Model Library, Model Identity) and **Tools** (Arena)
- List endpoints now use pagination (default 200, max 500); on startup and graceful shutdown, orphaned `running` tasks are corrected to `interrupted`
- Optional per-model pricing (input / output / cache read / cache write price per million token) to drive cost estimation

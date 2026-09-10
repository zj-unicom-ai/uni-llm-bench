[中文](CONTRIBUTING.md) | **English**

# Contributing to Uni LLM Bench

Thanks for your willingness to contribute! This document covers dev environment setup, the checks run by CI, and code conventions for keeping things consistent.

## Development Environment

### Prerequisites

- Node.js 20+ (CI runs on Node 20)
- npm 10+
- Git

### Local Development

```bash
git clone https://github.com/zj-unicom-ai/uni-llm-bench.git
cd uni-llm-bench
cp .env.example .env

# Backend — http://localhost:3001
cd backend && npm install && npm run dev &

# Frontend — http://localhost:5173
cd ../frontend && npm install && npm run dev
```

The backend watches `src/` and auto-restarts; the frontend uses Vite HMR and proxies `/api` to port 3001. In production, the built frontend is served by Express on port 3001.

Health check: `curl http://localhost:3001/api/health` → `{"status":"ok"}`.

> **About login**: The `AUTH_PASSWORD` in `.env` is only used to initialize the admin account on the first run (when the `users` table is empty). Once you change the password in the UI, the new hash is stored in the database and `.env` no longer takes effect — please use the password you set in the UI instead.

### Docker

```bash
cp .env.example .env
docker compose up -d
```

## Project Structure

```
├── backend/
│   └── src/
│       ├── providers/     # Provider adapters (OpenAI, Anthropic, Gemini, etc.)
│       ├── routes/        # API route handlers
│       ├── services/      # benchmark / Workflow / identity engine and stores
│       ├── middleware/    # auth
│       ├── utils/         # secrets, encryption, pricing, error classification
│       └── validation/    # Zod schemas
├── frontend/
│   └── src/
│       ├── components/    # UI components and pages
│       ├── hooks/         # data-fetching hooks
│       ├── i18n/          # en.json / zh.json (kept in sync, enforced by tests)
│       ├── services/      # API clients
│       ├── utils/         # token counting, cost estimation, demo mode
│       └── data/          # ShareGPT prompt corpus (1k–256k)
├── design/                # design docs (Chinese and English)
├── docs/screenshots/      # README images
├── docker-compose.yml
├── Dockerfile
└── start.sh
```

## Checks to run before opening a PR

The following checks are run by CI on every push and PR. Run them locally first to avoid waiting on a red build:

```bash
# Frontend
cd frontend && npx tsc --noEmit
cd frontend && npx eslint .
cd frontend && npm test

# Backend
cd backend && npx tsc --noEmit
cd backend && npx eslint .
cd backend && npm test
```

### Formatting

Format your changes with Prettier before committing:

```bash
npx prettier --write .
```

The repo's Prettier config lives in `.prettierrc` and ignores build artifacts, database files, and the root `README.md`. Keep added and modified files formatted. (Some existing source files are not yet Prettier-formatted; we'll clean them up when we get the chance — they don't block CI, but new code should be formatted.)

## Code Conventions

- **Language** — Code, comments, and commit messages use English. User-facing copy goes in `frontend/src/i18n/`, and must have both English and Chinese.
- **Commit messages** — Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `style:`, `ci:`, `test:`
- **Frontend** — React functional components, TypeScript strict mode, Tailwind CSS v4. Design tokens live in `frontend/src/index.css` — reuse them rather than hardcoding colors.
- **Ant Design** — Import antd components from `frontend/src/antdImports.ts`, not directly from `antd`, to keep the bundle output under control.
- **Backend** — Routes → services → SQLite. Write raw SQL with `better-sqlite3`, no ORM, and it must be parameterized (never concatenate request input into SQL strings).
- **Measurement** — For metrics that cannot be measured, do not fill in defaults or simulated values — return `null` so the UI shows `N/A`. This is a hard rule; see the "Measurement Credibility" section in the README.

### Gotchas worth knowing

**Adding a field to a provider's model requires changing three places.** The `models` column is JSON, so no migration is needed, but fields will be silently dropped unless you also update:

1. `backend/src/types.ts` → `ModelConfig`
2. `backend/src/validation/schemas.ts` → `ModelConfigSchema` (Zod strips unknown keys, so unregistered fields never reach the handler)
3. `backend/src/routes/providers.ts` → create (POST `/`) and update (PUT `/:id`) — both are explicit field-by-field mappings

**Adding a new page requires changing two files.** First add the key to the `PageType` union type and the `groups` array in `components/Sidebar.tsx`, then add `PAGE_ROUTES`, `pageConfig`, `activePage` route resolution, and the `<Route>` in `App.tsx`.

**i18n keys must stay in sync.** `frontend/src/i18n/i18n.test.ts` asserts that `en.json` and `zh.json` have exactly the same non-empty keys. Adding to only one side will fail the build.

**The guided tour is page-level.** Tour steps locate elements via the `data-tour` attribute, and the trigger button lives inside the page rather than the global top bar — see `components/GuidedTour.tsx`.

**Long-form docs are provided as mirrored Chinese/English pairs.** `design/DESIGN.md` ↔ `design/DESIGN-en.md`, `README.md` ↔ `README-en.md`, `CONTRIBUTING.md` ↔ `CONTRIBUTING-en.md`, `SECURITY.md` ↔ `SECURITY-en.md`, `CHANGELOG.md` ↔ `CHANGELOG-en.md` — change one side and you must sync the other. New entries go under `[Unreleased]`; when releasing, move them to a new `## [x.y.z] - YYYY-MM-DD` heading, and don't rewrite already-published sections.

## Adding a Provider adapter

1. Create an adapter under `backend/src/providers/` following the existing pattern
2. Implement the same interface as `DynamicProvider` (`backend/src/providers/adapter.ts`): one non-streaming + one streaming code path per wire format (`callOpenAI` / `callOpenAIStreaming`, `callAnthropic` / `callAnthropicStreaming`, `callGemini` / `callGeminiStreaming`), all exposed uniformly via `execute()`
3. Register it in the provider factory
4. Add the new format to `backend/src/types.ts`, the Zod schema, and the Model Library's format selector
5. All cost calculations go through the unified pricing module — don't add unit-price constants in the adapter

## How to contribute

### Reporting bugs

1. Search [existing issues](https://github.com/zj-unicom-ai/uni-llm-bench/issues) first
2. Use the **Bug Report** template
3. Include reproduction steps, expected vs. actual behavior, and necessary screenshots

### Suggesting features

1. Open an issue with the **Feature Request** template
2. Describe the use case and value

### Submitting code

1. Fork the repo
2. Create a branch from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```
3. Make your changes following the conventions above
4. Run the checks above
5. Commit with a clear message:
   ```bash
   git commit -m "feat: add support for X"
   ```
6. Push and open a Pull Request against `main`

Keep PRs focused — one PR for one logical change makes review much faster.

## License

By submitting a contribution, you agree that your contribution is licensed under the [MIT License](LICENSE).

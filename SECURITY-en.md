[中文](SECURITY.md) | **English**

# Security Policy

## Supported Versions

Uni LLM Bench is self-hosted software. We recommend always running the latest release: security fixes land on `main` and ship with the next tag.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Older versions | ❌ (please upgrade) |

## Trust Model

Uni LLM Bench is positioned as a **single-tenant, self-hosted** tool, not a multi-tenant SaaS:

- Anyone who can reach the login page can attempt authentication, so treat it as private infrastructure — place it behind a VPN or a TLS-terminating reverse proxy, and do not expose it directly to the public internet without that layer of protection.
- The system has **one** user account, configured via `AUTH_USERNAME` / `AUTH_PASSWORD`. Anyone authenticated has full privileges: access to all configured Providers, API keys, and the entire benchmark history.
- This tool makes **outbound** requests to all LLM endpoints you configure, sending your prompts (and, in vision tests, the image URLs you provide) to those third-party Providers. Do not configure endpoints whose data handling you do not trust.

## Credential Handling

Provider API keys are the most sensitive data held by this application.

- **Encryption at rest** — keys are encrypted with AES before being written to SQLite (see `backend/src/utils/encryption.ts`); the encryption key is derived from `ENCRYPTION_SECRET`, which is auto-generated and persisted on first run if not set.
- **Never returned by the API** — Provider-related endpoints only expose `apiKeyMasked` (e.g. `sk-…abcd`). The decrypted key is used only server-side, for making provider calls and "Test Connection".
- **Not in URLs or logs** — the Gemini adapter sends the key via the `x-goog-api-key` request header rather than the `?key=` query string, so it is never leaked into access logs.
- **Backups** — the SQLite file contains the encrypted keys. Back it up with the same care you would give the keys themselves, and back up `ENCRYPTION_SECRET` **separately**: without it, stored keys cannot be recovered.

### Application Secrets

`JWT_SECRET`, `ENCRYPTION_SECRET`, and `ENCRYPTION_SALT`, when left blank in `.env`, are auto-generated on first run and persisted to `backend/data` with `0600` permissions. Passwords are hashed with bcrypt, which generates an independent salt per hash — so there is no "password salt" for you to manage.

The source ships with default key constants, used only as a fallback. Deployments still using the defaults are warned at startup, and provider API keys encrypted with the default key are transparently re-encrypted with the deployment's real key. These defaults are never used for signing or encryption during normal operation.

## Built-in Protections

- JWT authentication, with forced password change on first login
- Login rate limiting (5 attempts / 5 minutes)
- Helmet security response headers, including Content Security Policy (CSP)
- One-time tokens for SSE and download links; JWT never appears in the query string
- token stored in `sessionStorage`, cleared when the tab is closed
- CORS restricted to configured origins, same-origin by default
- Fully parameterized SQL (`better-sqlite3` prepared statements)
- Docker image runs as a non-root user, with development dependencies stripped

## Deployment Recommendations

1. **Change the default password immediately.** `AUTH_PASSWORD` defaults to `changeme`, and the app forces you to change it on first login.
2. **Generate your own secrets** — for production, generate independent secrets for `JWT_SECRET` and `ENCRYPTION_SECRET` and back them up securely.
3. **Terminate TLS at the reverse proxy**, and set `CORS_ORIGIN` to your real domain.
4. **Restrict network access** — keep the instance private unless you truly need it exposed.
5. **Back up** `backend/data/benchmarks.db` (along with your secrets file) — it holds all history, configuration, and encrypted keys.

## Reporting Vulnerabilities

Please **do not** open a public issue for security problems.

Please report them privately via this repository's [GitHub Security Advisories](https://github.com/zj-unicom-ai/uni-llm-bench/security/advisories/new).

Please include:

- A description of the problem and its impact
- Steps to reproduce, or a proof of concept
- The affected version or commit
- Suggested mitigations (if any)

We will try to acknowledge the report within a few days and work with you on a fix and a coordinated disclosure timeline. Please give us a reasonable window to fix things before any public disclosure.

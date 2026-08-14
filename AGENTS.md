# Repository Guidelines

## Project Overview

StarNav (星漫旅站) — a personal/team bookmark navigation system running as a Cloudflare Worker with D1 + KV, written in dependency-free ESM JavaScript. Fork of Quanda666/StarNav. Key features: bookmark nav pages, admin auth, site lock (整站锁), private bookmarks, browser-favorites sync, an MV3 browser extension, PWA, AI chat/auto-tags, webhooks, and scheduled backups.

## Architecture & Data Flow

Single worker entry, hand-rolled routing — no framework, no runtime dependencies.

```
fetch → withSecurityHeaders (central security headers)
      → routeRequest:
          ensureSchema (idempotent D1 migrations, every request)
          → PWA handlers (return null = fall through)
          → site-lock gate (allowlist: /admin, /static/, /api/settings/public)
          → prefix dispatch:
              /api/*      → handlers/api.js (giant exact path+method if-chain)
              /go/:id     → handlers/go.js (redirect + hit count + favicon backfill)
              /admin, /static → handlers/admin.js
              else        → pages/home.js (server-rendered HTML)
scheduled → health check + backup via ctx.waitUntil
```

- Handlers call services; services talk to D1: `env.NAV_DB.prepare(sql).bind(...).run()/first()/all()`; multi-statement writes via `env.NAV_DB.batch([...])` (no transaction API). `batch` is the multi-statement pattern — do not hand-roll loops of `run()` for atomic writes.
- `env` and `ctx` are passed explicitly as the first parameters through every function. No global/request-scoped mutable state (only module-level caches like `ADMIN_ASSETS` version hashes and a per-request `WeakMap` auth cache).
- Data split: D1 (`NAV_DB`, database "homepage") holds relational data (sites, spaces, categories, tags, settings, operation_logs, search_terms, pending_sites); KV (`NAV_AUTH`) holds sessions, sha256 API-token hashes, site-lock state, webhook config, backup snapshots, and `favicon:failed:{id}` markers.
- Home page HTML is edge-cached (Cache API read-through, `Cache-Control: public, max-age=0, s-maxage=60`). Cache key is per-anonymous-request: only used when no auth cookies present and keyed by catalog/sort/tag/lang. Layout-fragment requests (`?layout=...`) bypass the cache.

## Key Directories

| Path | Purpose |
|---|---|
| `src/handlers/` | Request handlers. `api.js` is one 864-line if-chain; route helpers in `api/sites.js`, error handling in `api/errors.js` |
| `src/services/` | D1-backed domain logic. `siteService.js` is the core (2122 lines); also migration, backup, ai, webhook, sync, settings, private-bookmark |
| `src/lib/` | Infrastructure: `auth.js`, `crypto.js` (AES-GCM), `ssrf.js` (safeFetch), `edgeCache.js`, `i18n.js`, `utils.js` (response factories), `favicon.js` |
| `src/pages/` | Server-rendered HTML via template literals. `home/` fragment renderers, `adminAssets.js` (static assets with ETag), `home/generated-css.js` (committed generated CSS) |
| `tests/` | 16 `*.test.js` files, `node:test`, ~120 tests |
| `extensions/browser-bookmark/` | MV3 extension: `popup.js` (3 views), `popup-logic.js` (pure logic, unit-tested), `options.js`, `background.js` |
| `openspec/` | Spec-driven changes: `changes/<name>/{proposal,design,tasks}.md` + `specs/`; completed changes archived to `changes/archive/YYYY-MM-DD-name/` |
| `docs/` | Chinese docs + `adr/` decisions |
| `scripts/` | `build-css.mjs`, `check-syntax.js` |

## Development Commands

```bash
npm install            # devDeps only: wrangler ^4.93.0, tailwindcss ^3.4.19
npm run dev            # build:css + wrangler dev
npm test               # node --test (Node >= 20)
npm run check          # node scripts/check-syntax.js — syntax-check all .js (src/, scripts/, extensions/)
npm run quality        # check + test — the CI gate
npm run build:css      # Tailwind → commits CSS into src/pages/home/generated-css.js
npm run deploy         # build:css + wrangler deploy
npm run db:init        # wrangler d1 execute homepage --file=./schema.sql
npm run db:backup      # wrangler d1 export homepage --output=backup.sql
npm run tail           # wrangler tail
```

Local run needs real D1/KV IDs in `wrangler.toml` (placeholders `REPLACE_WITH_YOUR_...`); CI injects them from secrets into a generated `wrangler.deploy.toml`.

## Code Conventions & Common Patterns

- **Exports**: named async functions only. Default export only in `src/index.js` (the worker object `{fetch, scheduled}`).
- **Signature order**: `(env, ctx, ...args)` / `(request, env, ctx)`; `env` always first or second.
- **Errors**: services `throw new Error(...)` with `error.code` (e.g. `DUPLICATE_URL` → 409). Handlers wrap everything in try/catch → `handleApiError` (`src/handlers/api/errors.js`). Response shape: `{ code: <http status>, message, error: { code: <UPPER_SNAKE>, message }, details? }`. **Never leak 5xx internals** — messages are hidden for 5xx.
- **Responses**: build via factories in `src/lib/utils.js`: `jsonResponse` / `errorResponse` / `htmlResponse` / `textResponse`. Never `new Response(...)` directly in handlers.
- **Auth**: three independent schemes.
  - Admin cookie session: `nav_admin_session`, KV `session:<uuid>`, 12h sliding TTL (refresh throttled to half-window) with 7d absolute cap; PBKDF2-SHA256 (100k iters) password with legacy-plaintext auto-upgrade.
  - Bearer API tokens: `nav_<id>_<secret>`; KV stores only the sha256 hash; scopes `read` / `write` / `admin`; constant-time compare.
  - Site-lock / private-bookmark cookies: KV-backed tokens, sliding-renew throttled.
  - Gate with `requireAdmin(request, env, { allowApiToken, scope })` → returns `null` (pass) or an error Response.
  - ADR 0002: any valid Bearer token grants private-bookmark read access (token = password-level credential).
- **Security**: every outbound fetch MUST go through `safeFetch` (`src/lib/ssrf.js`, redirect-aware, blocks private/reserved hosts, 5-hop max). Escape all user data in HTML with `escapeHTML`. `withSecurityHeaders` adds nosniff, frame options, and CSP Report-Only centrally.
- **Naming**: camelCase in JS; D1 columns are snake_case — `normalize*` helpers bridge the two (e.g. `normalizeSite`). URL canonicalization lives in `url_key` (strip www/trailing slash/case, keep query, http==https).
- **Fire-and-forget** side effects (hit counts, favicon backfill, cache.put, backups) via `ctx.waitUntil`, never awaited in the response path.
- **Configuration**: D1 settings rows (`system.*`, `ai.*`) with code defaults; env vars only for secrets/knobs (`SECRET_KEY`, `PRIVATE_BOOKMARKS_PASSWORD`, `ENABLE_PUBLIC_SUBMISSION`, `HEALTH_CHECK_CRON_LIMIT`).
- **Language**: comments and git commits in Chinese. Domain terms MUST follow `CONTEXT.md` glossary (canonical term + explicit "Avoid" list), e.g. 整站锁 not 全站锁, 同步书签/手动书签 not 导入书签.
- **Schema changes**: never edit `schema.sql` alone — runtime migrations live in `src/services/migrationService.js` (`CREATE TABLE IF NOT EXISTS` + `ensureColumn`), applied on every request.
- **CSS**: Tailwind 3.4 scans `./src/**/*.js` (excluding `generated-css.js`); run `npm run build:css` and commit the regenerated file; `home-custom.css` is appended after utilities so it overrides.

## Important Files

| File | Why |
|---|---|
| `src/index.js` | Worker entry, router, security-header wrapper, scheduled handler |
| `src/handlers/api.js` | All REST API routes (auth gate, JSON parsing, error mapping) |
| `src/handlers/api/errors.js` | `requireAdmin` + `handleApiError` — the error contract |
| `src/services/siteService.js` | Core bookmark domain: CRUD, visibility, search scoring, health checks |
| `src/services/migrationService.js` | `ensureSchema` — idempotent migrations per request |
| `src/lib/auth.js` | Sessions, tokens, throttling |
| `src/lib/utils.js` | Response factories + `withSecurityHeaders` + sanitizers |
| `wrangler.toml` | Bindings `NAV_DB` / `NAV_AUTH`; placeholder IDs replaced by CI |
| `schema.sql` | Canonical schema for `db:init` / CI deploy |
| `CONTEXT.md` | Domain terminology glossary — read before touching access-control/sync/icon features |
| `docs/api-guide.md` | API conventions, auth, endpoints, error format |
| `extensions/browser-bookmark/manifest.json` | Extension version must match release tag (`v*`) |
| `openspec/changes/` | Every feature change ships proposal/design/tasks + tests + CONTEXT.md glossary updates |

## Runtime/Tooling Preferences

- Node >= 20 (CI pins 22 on ubuntu-latest), npm (`npm ci`), ESM (`"type": "module"`; `tailwind.config.cjs` deliberately .cjs).
- **Zero runtime dependencies** — pure Workers runtime APIs only. Adding a dependency needs strong justification.
- Wrangler 4.x, `compatibility_date = "2024-01-01"`. Cron triggers are intentionally NOT in `wrangler.toml` (quota); add `[triggers]` only if required.
- Committed generated artifacts: `src/pages/home/generated-css.js` (deploy depends on it), `dist/` is gitignored.
- Do not touch `vt.json` (stray vision-model probe payload, not config).

## Testing & QA

- **Framework**: `node:test` + `node:assert/strict`, flat `test('...', async () => {...})` (no describe/it). Run: `npm test`; gate: `npm run quality` (syntax check + tests), enforced by `.github/workflows/quality.yml` on push/PR.
- **Mocking pattern** (no shared helper — each file defines its own):
  - `createMemoryKv()` — Map-backed get/put/delete/list.
  - `createMockEnv()` — `{ NAV_AUTH: memoryKv, NAV_DB: { prepare() { throw ... } } }`; D1 mocks dispatch on SQL substrings over `prepare().bind().all()/first()/run()`, optionally `batch()` (see `tests/bookmarkSync.test.js`).
  - Outbound fetch: `t.mock.method(globalThis, 'fetch', ...)` (auto-restored per test).
  - `waitUntil` captured via a ctx object pushing tasks to an array, then `await Promise.all(tasks)`.
  - Handlers are invoked directly with mock env + ctx — never through the worker entry.
- **Determinism**: no fake timers — relative `Date.now()` offsets captured at module load; real WebCrypto with a fixed test `SECRET_KEY`; test-only resets like `resetMigrationStateForTest()`.
- **Extension tests**: `popup-logic.js` loaded via `vm.runInThisContext` (UMD, repo is ESM); `popup-view-persist.test.js` uses source-regex assertions as regression locks.
- **Test naming**: newer tests in Chinese with full-width colon, e.g. `test('isFullBrowseCache：仅 kind==="full" 且 items 为数组', ...)`; assert messages in Chinese.
- **Coverage gaps** (add tests when touching): worker entry routing, `handlers/pwa.js` / `admin.js`, `api/sites.js` CRUD beyond the auth gate, `api/spaces.js`, `api/discovery.js`, most pages, `aiService`, `backupService`, `categoryService`, settings services. Well-covered: site lock, auth/tokens, API errors, bookmark sync, migration, go redirect, favicon, ssrf, edge cache, popup logic.
- **Deployment QA**: `docs/deployment-checklist.md` requires quality pass + `wrangler deploy --dry-run`; deploy workflow re-runs schema.sql remotely (idempotent) and fails if wrangler.toml placeholders remain.

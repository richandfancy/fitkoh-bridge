# FitKoh Bridge

**Clock PMS ↔ Poster POS bridge** with real-time ops dashboard and public API hub.

> Cross-project principles in `~/.claude/CLAUDE.md`. This file is project-specific.

## URLs
- **Production:** `bridge.fitkoh.app`
- **Staging:** `s.bridge.fitkoh.app`
- **API docs:** `bridge.fitkoh.app/docs` (Scalar)
- **MCP:** `bridge.fitkoh.app/mcp` (Streamable HTTP)
- **Repo:** `richandfancy/fitkoh-bridge`

## Stack
- **Worker:** Cloudflare Workers + Hono + `@hono/zod-openapi` (TypeScript)
- **Database:** Cloudflare D1 (SQLite)
- **Config:** Cloudflare KV
- **Frontend:** React 19 + Vite 7 + Tailwind v4 (dark theme, Space Grotesk)
- **Dashboard Auth:** Cookie-based shared secret (`DASHBOARD_SECRET`)
- **Public API Auth:** X-API-Key header or Bearer JWT (short-lived, issued to FitKoh app users)

## Project Structure
```
client/          -> React SPA (Cloudflare Pages assets)
worker/          -> Hono API (Cloudflare Workers)
shared/          -> TypeScript types
migrations/      -> D1 SQL migrations
```

## Development
```bash
pnpm dev              # Start client (5173) + worker (8787)
pnpm check            # TypeScript check
pnpm build            # Build client to dist/
pnpm db:migrate       # Apply D1 migrations locally
pnpm db:migrate:remote # Apply D1 migrations to production
```

## Deployment (NEVER skip staging)
**Deploys are manual** — Cloudflare Workers Git integration is NOT wired. Pushing to `staging` or `main` updates the git branch but does not deploy. You must run `wrangler deploy` yourself.

1. Commit your changes first (the `swVersionPlugin` bakes `git rev-parse HEAD` at build time — build before commit → stale SW cache version).
2. Push to `staging` so the branch reflects what's about to deploy.
3. `pnpm build` (rewrites `dist/sw.js` with `CACHE_VERSION = 'bridge-{sha8}'`).
4. `cd worker && npx wrangler deploy --env staging` → `bridge-staging.fitkoh.app`.
5. **Verify by asset-hash diff**, not `/api/health`:
   - `curl -s https://bridge-staging.fitkoh.app/ | grep -oE 'assets/[^"]+\.js'` → hash should change between deploys.
   - `curl -s https://bridge-staging.fitkoh.app/sw.js | grep CACHE_VERSION` → must match your committed HEAD.
6. Smoke test on staging for 5 minutes minimum.
7. Merge `staging` → `main` and repeat: `pnpm build && cd worker && npx wrangler deploy` (no `--env` flag deploys to production `bridge.fitkoh.app`).

`curl https://bridge.fitkoh.app/api/health` is a *worker uptime* check — it returns 200 even if the deploy silently failed or you deployed stale assets. Trust the asset hash.

## Architecture Decisions

### Two API surfaces
- `/api/dashboard/*` — cookie auth, for the bridge's own UI
- `/api/v1/*` — API key + JWT auth, for external consumers (FitKoh app, Homebase, etc.)

### DEMO_MODE (Poster writes)
`guest-sync.ts` has `DEMO_MODE = true` which prevents real Poster client creation. Flip to `false` when going live. Until then, mock client IDs are generated deterministically from Clock booking ID.

### Clock PMS: mock until credentials arrive
`clock-mock.ts` implements the `ClockClient` interface. Swap for a real implementation when API key is available from Pavel. Zero route/service changes needed.

### Realtime strategy
- D1 cache with 30s TTL (poster_meals_cache table)
- Cloudflare Cron Trigger pre-warms cache every 60s
- Server-Sent Events (SSE) for live feeds to dashboards
- NO Durable Objects yet — add only when a specific use case demands WebSocket push (kitchen display, rate limiting)

### Latency budget
User-facing requests must return in <50ms. Path: Browser → Cloudflare edge → D1 cache → Response. NEVER put Poster API in the hot path — always cached.

## Secrets
- `POSTER_ACCESS_TOKEN` — Poster POS API token
- `DASHBOARD_SECRET` — Dashboard login code
- `RESEND_API_KEY` — Email alerts (optional)
- `JWT_SECRET` — For signing bridge JWTs issued to FitKoh users (HS256)
- `CLOCK_API_USER`, `CLOCK_API_KEY`, `CLOCK_SUBSCRIPTION_ID`, `CLOCK_ACCOUNT_ID` — Clock PMS credentials (when available)

## Going live: DEMO_MODE → real checklist

Before switching Clock PMS + Poster guest sync from mock to real, run through:

1. `guest-sync.ts:7` — set `DEMO_MODE = false`; delete `mockClientId` helper.
2. `grep -rn "new MockClockClient()" worker/` returns **zero hits** (should all route through `getClockClient()`).
3. `snsSignatureAuth` middleware in `worker/src/middleware/sns-auth.ts` is the real implementation (not the stub) before removing `dashboardAuth` on `/api/webhooks/*`.
4. Migration: backfill real `poster_client_id` for bookings created during demo (where `poster_client_id >= 900000` — the deterministic hash range).
5. Flip `NotificationRecipient` from hardcoded `pavel@fitkoh.app` to an on-call list via `BRIDGE_ALERT_EMAIL` env var.
6. Smoke-test `POST /api/admin/sync/:id` against a Poster staging account BEFORE accepting the first real SNS webhook.

## Seed Data (local dev)
```bash
curl -X POST http://localhost:8787/api/admin/seed \
  -H "Cookie: bridge_session=dev-bridge-2026"
```

## Key References
- Spec: `~/Apps/docs/superpowers/specs/2026-04-07-fitkoh-system-bridge-design.md`
- Linear: BAC-786 (main ticket), BAC-804, BAC-821, BAC-831, BAC-835

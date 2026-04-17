# FitKoh System Bridge
> Dashboard for bridging FitKoh systems via Cloudflare Pages + Functions

**Path:** `~/Apps/fitkoh-system-bridge`
**Status:** Active
**Stack:** React 19, Vite 7, Tailwind v4, Hono, Cloudflare Pages/Functions, D1, KV, wouter, zod
**URLs:** TBD (not yet deployed)

## What This Is
A Cloudflare Pages + Functions project that serves as a system bridge dashboard for FitKoh. The frontend is React with Tailwind v4 and wouter routing, served as a SPA. The backend is a Hono API running as Cloudflare Workers with D1 (SQLite) and KV storage bindings.

## Key Decisions
- Cloudflare Pages + Functions (not Railway) for edge deployment
- Hono over itty-router for API layer (consistent with other CF projects)
- wouter over react-router for lightweight client routing
- D1 for structured data, KV for configuration
- Vite dev server proxies /api/* to local wrangler on port 8787

## Session Log
| Date | Summary |
|------|---------|
| 2026-04-07 | Project design: brainstormed architecture, explored Clock PMS + Poster POS APIs, verified Poster token works, wrote full spec. BAC-786. |
| 2026-04-07 | Poster API exploration: tested all endpoints, mapped 154 Poster products to FitKoh menu items, created 46 new menu items + 13 supplement serving items with product photos. Imported 353 meal logs for Michael + 414 for Chris via new REST import endpoint. |
| 2026-04-08 | Full implementation: scaffold, worker foundation (env, auth, D1 migration, queries), service layer (real Poster client, mock Clock with European guests, notifications, guest-sync, invoice-transfer), all API routes (webhooks, admin, dashboard, pre-invoice, guest meals), client foundation (auth, floating nav, login), all 6 dashboard pages (Activity, Guests, GuestDetail, DeadLetters, Settings, PreInvoice). tsc passes clean. |
| 2026-04-07 | Webhook event bus refactor: replaced direct FitKoh coupling (auto-importer.ts) with generic webhook dispatcher. New D1 migration (0004_webhooks), WebhookSubscription + BridgeEvent types, HMAC-SHA256 signed dispatch, admin CRUD endpoints (/webhooks, /webhooks/:id/test, toggle, delete), auto-disable after 10 failures, 30s subscription cache. Removed FITKOH_API_URL/KEY from env. pnpm check + build pass. |
| 2026-04-12 | Fixed 9 Important code review issues (BAC-952): S3 seed prod guard, S4 JWT/docs-auth prod throw, S5 SSE security docs, P2 products cache (5min TTL), P3 transactions cache (30s TTL), P4 N+1 batched Promise.all (pre-invoice + guest meals), Q1 duplication comments, R1 atomic INSERT OR IGNORE dedup, R2 SQL failure_count increment, A1 replaced real PII with fake data. |
| 2026-04-12 | Fixed I1 CORS localhost in production (BAC-954): env-aware CORS middleware using createCorsMiddleware() factory. Fixed I2 dedup claim persistence (BAC-955): delete D1 row on dispatch failure so retries work. |
| 2026-04-16 | **KV limit hit** — bridge writes KV ~2880×/day (heartbeat + live_orders_snapshot every cron tick). Exceeded CF free tier (1000 writes/day). Upgraded account to CF paid plan ($5/month, 1M writes/day). No code change needed. **Product mapping**: Poster productId 917 (Amino Energy Electrolyte AE709) is a shop item — not a cafe order — so no FitKoh menu mapping needed. Shop items in Poster should NOT be bridged to FitKoh item logs. |
| 2026-04-17 | Added `office@fitkoh.com` to `BRIDGE_ADMIN_EMAILS` allowlist on both staging + production workers via `wrangler secret put`. Current allowlist: `michaelgrillhoesl@gmail.com, office@fitkoh.com`. Pending end-user verification via magic-link sign-in. BAC-1132. |
| 2026-04-17 | **Massive staging refresh**: PWA foundation + FitKoh-style floating tab bar + mobile card layout + realtime punch-time sort + fast-forwarded `staging` → `main` (brought BAC-1080 magic-link, BAC-1043, BAC-1053, BAC-1065, BAC-1068, BAC-1071, BAC-1081, BAC-1093 across). Closed BAC-1132/1146/1147/1149/1151/1152. Discovered: Bridge `CLAUDE.md` lied about auto-deploy — fixed to document manual `wrangler deploy`. Poster's `dash.getTransactions` returns unix-ms timestamps; `transactions.getTransactions` returns `"YYYY-MM-DD HH:MM:SS"` — normalize at the edge. SW version must be derived AFTER commit (build-before-commit bakes parent SHA). Verify deploys by asset-hash diff, not `/api/health`. |

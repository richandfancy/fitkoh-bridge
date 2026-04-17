# Bridge Learnings

Project-specific patterns and gotchas. Cross-project principles live in `~/.claude/CLAUDE.md`.

## Poster API

### Timestamp formats are not consistent across endpoints
- `dash.getTransactions` → `date_start` / `date_close` as **unix-ms strings** (e.g. `"1776400559048"`).
- `transactions.getTransactions` → `date_close` as **`"YYYY-MM-DD HH:MM:SS"`** strings.
- `dash.getTransactionHistory` → per-event `time` as **unix-ms strings**.

Always normalize at the edge. `toIso()` in `worker/src/services/cache-warmer.ts` handles all three + `"0"`/empty. A silent-NaN bug shipped once when the parser assumed one format everywhere.

### Field names aren't reliable contracts
`transactions.getTransactions.date_close` empirically moves on open-bill punches (not just on bill close), but it's called "close" so anyone reading the code assumes otherwise. When semantics matter, prefer documented event logs: `dash.getTransactionHistory(txnId)` returns every `additem` / `open` / `close` / `sign` with timestamps.

### `client_id` isn't reliably on every feed
- `transactions.getTransactions` returns `client_id: 0` on most rows regardless of CRM assignment.
- `dash.getTransactions` does carry the real `client_id`.

Pattern: build `clientIdByTxn: Map<number, string>` from `dashArr`, then cross-reference when you need per-client data from the detailed feed.

### Shop items ride the same transaction schema as cafe orders
A T-shirt sale is structurally identical to a Moroccan chickpea stew — same `table_id`, same `spot_id`, same `products[]`. In Poster they appear under whatever spot the shop POS is configured for (often the cafe's `GYM CAFE Sasa`). Shop transactions should NOT be bridged to FitKoh meal logs; detect via `table_id` range or product category.

## Deploys

### Cloudflare git integration is NOT wired
Pushing `staging` or `main` to GitHub does nothing automatic. All deploys are manual: `pnpm build && cd worker && npx wrangler deploy --env staging` (or no `--env` for prod).

### Commit before you build
`swVersionPlugin` in `vite.config.ts` reads `git rev-parse HEAD` at build time. Build-before-commit bakes the *parent* SHA into `sw.js` and your PWA users never see the update banner.

### Verify by asset-hash, not `/api/health`
The worker happily returns `{ok:true}` even when serving a stale deploy. Real checks:
- `curl -s https://<env>/ | grep -oE 'assets/[^"]+\.js'` — hash must change between deploys.
- `curl -s https://<env>/sw.js | grep CACHE_VERSION` — must match committed HEAD SHA.

## Auth

### Magic-link flow (BAC-1080)
- Allowlist in `BRIDGE_ADMIN_EMAILS` secret (comma-separated, lowercased).
- Rate-limited to 5 req / 15min per email in-memory (OK for low-volume admin).
- `/api/auth/request-link` never leaks allowlist membership — always returns `{ok:true}` for well-formed emails.
- `/auth/callback` re-checks the allowlist, so removing someone revokes their in-flight tokens.

### Serve `/sw.js` with `no-cache` headers
Handled by the worker route in `worker/src/index.ts`. Without these headers, Cloudflare edges cache `sw.js` for hours and PWA update detection breaks silently — the new SW file is never even fetched.

## Realtime / KV

### `live_orders_snapshot` is the hot path
Cron warms it every 60s. Every dashboard read hits KV, not Poster. Enables sub-50ms dashboard loads and keeps Poster API usage to ~3 calls/min regardless of how many dashboard clients are connected.

Consumers read `lastPunchByClient` (per-client punch time) and `items[]` (per-line live feed). Format is documented in `cache-warmer.ts` above the `env.CONFIG.put`.

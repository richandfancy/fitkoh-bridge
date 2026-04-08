# FitKoh System Bridge

**Clock PMS ↔ Poster POS bridge** with real-time ops dashboard.

> Cross-project principles in `~/.claude/CLAUDE.md`. This file is project-specific.

## Stack
- **Worker:** Cloudflare Workers + Hono (TypeScript)
- **Database:** Cloudflare D1 (SQLite)
- **Config:** Cloudflare KV
- **Frontend:** React 19 + Vite 7 + Tailwind v4 (dark theme)
- **Auth:** Cookie-based shared secret (`DASHBOARD_SECRET`)

## Project Structure
```
client/          -> React SPA (Cloudflare Pages)
worker/          -> Hono API (Cloudflare Workers)
shared/          -> TypeScript types
migrations/      -> D1 SQL migrations
```

## Development
```bash
pnpm dev              # Start client (5173) + worker (8787)
pnpm check            # TypeScript check
pnpm db:migrate       # Apply D1 migrations locally
```

## Key Decisions
- Clock PMS uses mock data until API credentials arrive (swap `MockClockClient` for real client)
- Poster POS uses real API (token in `.dev.vars`)
- Cookie auth with single shared secret — no user accounts
- Pre-invoice deduction (3 most expensive meals/day) computed server-side
- Floating bottom nav bar (mobile-first, consistent with FitKoh/Homebase apps)

## Secrets
- `POSTER_ACCESS_TOKEN` — Poster POS API token
- `DASHBOARD_SECRET` — Dashboard access code
- `RESEND_API_KEY` — Email alerts (optional)

## Seed Data
```bash
curl -X POST http://localhost:8787/api/admin/seed \
  -H "Cookie: bridge_session=dev-bridge-2026"
```

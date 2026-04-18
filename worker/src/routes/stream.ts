// Server-Sent Events (SSE) streams for the live Orders dashboard.
//
// Endpoint: GET /api/v1/stream/orders
//
// Auth: the dashboard uses cookie-based auth (bridge_session). External
// (non-browser) consumers pass a short-lived JWT via ?token=... because
// EventSource cannot send custom headers. Raw API keys (`fbk_...`) are
// rejected here — they would otherwise land in access logs, browser
// history, and HTTP Referer headers (BAC-1216 / C4). Mint a JWT via
// POST /api/v1/auth/token instead.
//
// Protocol:
//   event: snapshot     — first payload, full list of today's items
//   event: order_item   — each subsequent new item
//   : heartbeat         — SSE comment every ~15s to keep the connection alive
//
// The stream self-terminates after MAX_DURATION_MS so clients gracefully
// reconnect (EventSource retries by default), avoiding stale workers.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { streamSSE } from 'hono/streaming'
import type { Env } from '../env'
import {
  buildOrdersSnapshot,
  readSnapshotFromKv,
  type LiveOrderItem,
} from '../services/orders-feed'
import { PosterClient } from '../services/poster'
import { verifyJwt } from '../services/jwt'
import { importItemsForUser } from '../services/auto-importer'
import { verifySessionToken } from '../lib/crypto'

const app = new OpenAPIHono<{ Bindings: Env }>()

// How long a single SSE connection is allowed to live (ms).
// 5 minutes keeps worker invocations bounded and lets EventSource reconnect.
const MAX_DURATION_MS = 5 * 60 * 1000

// Poster poll interval (ms). 2s matches the task spec.
const POLL_INTERVAL_MS = 2000

// Heartbeat interval in number of poll ticks (2s * 8 = 16s).
const HEARTBEAT_EVERY_TICKS = 8

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Item shape matches the KV snapshot written by orders-feed.ts. Re-aliased
// here so the SSE protocol contract is documented next to the stream code.
type LiveItem = LiveOrderItem

// ---------------------------------------------------------------------------
// Auth helper: accept dashboard cookie OR a short-lived JWT in the query.
//
// Raw API keys (fbk_...) are NOT accepted on this endpoint because query
// strings appear in Cloudflare access logs, Sentry breadcrumbs, browser
// history, and HTTP Referer headers. JWTs expire quickly, so even if they
// leak into a log the blast radius is bounded (BAC-1216 / C4).
// ---------------------------------------------------------------------------

async function isAuthorized(
  env: Env,
  cookieHeader: string | undefined,
  queryToken: string | undefined,
): Promise<boolean> {
  const sessionCookie = cookieHeader
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('bridge_session='))
    ?.split('=')[1]

  if (sessionCookie) {
    const valid = await verifySessionToken(env.DASHBOARD_SECRET, sessionCookie)
    if (valid) return true
  }

  if (queryToken) {
    const payload = await verifyJwt(env, queryToken)
    if (payload) return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Poster fetcher — returns today's flattened LiveItems sorted oldest → newest.
//
// Reads from the KV `live_orders_snapshot` that the cron warms every 60s.
// Falls back to a live Poster fetch only if KV is stale (>90s) or missing.
// This reduces Poster API calls from 90/min per SSE client to 3/min total.
//
// Both paths run through orders-feed so the SSE protocol shape stays
// lock-step with the cron output and the /api/dashboard/orders contract.
//
// TODO(BAC-1221): SSE integration test covering snapshot vs. delta emission
// and reconnect behavior when KV and Poster both fail.
// ---------------------------------------------------------------------------

async function fetchTodayItems(env: Env): Promise<LiveItem[]> {
  const today = new Date().toISOString().split('T')[0]

  const snapshot = await readSnapshotFromKv(env.CONFIG, { today })
  if (snapshot) return snapshot.items

  // Fallback: live Poster build (only if KV is stale or missing).
  const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)
  const built = await buildOrdersSnapshot(poster, { today })
  return built.items
}

// ---------------------------------------------------------------------------
// OpenAPI registration — SSE is documented as text/event-stream
// ---------------------------------------------------------------------------

// Exported so v1.ts can also register this on the main /api/v1/openapi.json
// spec (the stream sub-app intercepts the actual request at /api/v1/stream/*
// before v1's apiKeyAuth middleware runs).
export const streamOrdersRoute = createRoute({
  method: 'get',
  path: '/orders',
  tags: ['Streaming'],
  summary: 'Server-Sent Events stream of live Poster order items',
  description: [
    'Streams new Poster order items in real time using Server-Sent Events (SSE).',
    '',
    'The worker polls the Poster API every 2 seconds server-side and pushes:',
    '- an initial `snapshot` event containing all of today\'s known items, then',
    '- an `order_item` event for each newly observed transaction item.',
    '',
    'A `: heartbeat` comment is emitted every ~16s to keep the connection alive.',
    'The stream self-terminates after 5 minutes; clients should reconnect.',
    '',
    '**Auth:** pass the dashboard cookie (`bridge_session`) OR `?token=<jwt>`',
    'as a query parameter. EventSource cannot send custom headers, so header',
    'auth is not supported on this endpoint.',
    '',
    'Raw API keys (`fbk_...`) are REJECTED on this endpoint — query strings',
    'land in access logs, Sentry breadcrumbs, browser history, and HTTP',
    'Referer. Issue a short-lived JWT via `POST /api/v1/auth/token` and pass',
    'it as the `token` parameter instead.',
    '',
    'Example:',
    '```',
    'curl -N "https://bridge.fitkoh.app/api/v1/stream/orders?token=eyJ..."',
    '```',
  ].join('\n'),
  request: {
    query: z.object({
      token: z
        .string()
        .optional()
        .openapi({
          param: { name: 'token', in: 'query' },
          example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          description:
            'Short-lived bridge JWT (from POST /api/v1/auth/token). Alternative to the dashboard cookie for non-browser clients.',
        }),
    }),
  },
  responses: {
    200: {
      content: {
        'text/event-stream': {
          schema: z
            .string()
            .openapi({
              example:
                'event: snapshot\ndata: {"items":[],"count":0}\n\nevent: order_item\ndata: {"id":"157441-0","productName":"Cappuccino",...}\n\n',
            }),
        },
      },
      description: 'SSE stream. See description for event types.',
    },
    401: {
      content: {
        'application/json': {
          schema: z.object({ error: z.string() }),
        },
      },
      description:
        'Missing or invalid credentials. Also returned when a raw API key is passed in the query string.',
    },
  },
})

app.openapi(streamOrdersRoute, async (c) => {
  // Reject raw API keys in the query string before attempting auth. The
  // legacy `?api_key=` param is still read so we can return a clear error
  // for existing integrations, but anything starting with `fbk_` is always
  // refused — regardless of whether it would otherwise authenticate.
  const legacyApiKey = c.req.query('api_key')
  const queryToken = c.req.query('token')
  if (
    (legacyApiKey && legacyApiKey.startsWith('fbk_')) ||
    (queryToken && queryToken.startsWith('fbk_'))
  ) {
    return c.json(
      {
        error:
          'API keys cannot be passed in query strings. Use a short-lived JWT.',
      },
      401,
    )
  }

  const authorized = await isAuthorized(
    c.env,
    c.req.header('cookie'),
    queryToken,
  )
  if (!authorized) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  return streamSSE(c, async (stream) => {
    const seenIds = new Set<string>()
    const startTime = Date.now()
    let tick = 0

    // Initial snapshot
    try {
      const items = await fetchTodayItems(c.env)
      for (const item of items) seenIds.add(item.id)
      await stream.writeSSE({
        event: 'snapshot',
        data: JSON.stringify({ items, count: items.length }),
      })
    } catch (err) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          error: err instanceof Error ? err.message : 'Initial fetch failed',
        }),
      })
    }

    // Poll loop — push deltas
    while (
      !stream.aborted &&
      !stream.closed &&
      Date.now() - startTime < MAX_DURATION_MS
    ) {
      await stream.sleep(POLL_INTERVAL_MS)
      if (stream.aborted || stream.closed) break

      tick++
      if (tick % HEARTBEAT_EVERY_TICKS === 0) {
        // SSE comment line — ignored by EventSource but keeps proxies warm
        await stream.write(': heartbeat\n\n')
      }

      try {
        const items = await fetchTodayItems(c.env)
        const newItemsThisTick: LiveItem[] = []
        for (const item of items) {
          if (seenIds.has(item.id)) continue
          seenIds.add(item.id)
          newItemsThisTick.push(item)
          await stream.writeSSE({
            event: 'order_item',
            data: JSON.stringify(item),
          })
        }

        // Fire-and-forget inline import for new items
        if (newItemsThisTick.length > 0) {
          importItemsForUser(c.env, newItemsThisTick).catch((err) => {
            console.error('Inline import error:', err)
          })
        }
      } catch (err) {
        // Log but don't kill the stream — next tick will retry.
        console.error('SSE stream fetch error:', err)
      }
    }
  })
})

export default app

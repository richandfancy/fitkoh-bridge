// Server-Sent Events (SSE) streams for the live Orders dashboard.
//
// Endpoint: GET /api/v1/stream/orders
//
// Auth: the dashboard uses cookie-based auth (bridge_session), external
// consumers may pass ?api_key=fbk_... as a query param because EventSource
// cannot send custom headers. We verify either one and then stream.
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
import { verifyApiKey } from '../services/api-keys'
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
// Auth helper: accept cookie OR ?api_key= query param
// ---------------------------------------------------------------------------

async function isAuthorized(
  env: Env,
  cookieHeader: string | undefined,
  queryApiKey: string | undefined,
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

  if (queryApiKey) {
    const apiKey = await verifyApiKey(env.DB, queryApiKey)
    if (apiKey) return true
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
    '**Auth:** pass the dashboard cookie (`bridge_session`) OR `?api_key=fbk_...`',
    'as a query parameter. EventSource cannot send custom headers, so header',
    'auth is not supported on this endpoint.',
    '',
    'WARNING: Security note: API keys passed via query parameter appear in server logs and browser',
    'history. For production use, prefer issuing a short-lived JWT via POST /api/v1/auth/token',
    'and passing it as the api_key parameter instead.',
    '',
    'Example:',
    '```',
    'curl -N "https://bridge.fitkoh.app/api/v1/stream/orders?api_key=fbk_..."',
    '```',
  ].join('\n'),
  request: {
    query: z.object({
      api_key: z
        .string()
        .optional()
        .openapi({
          param: { name: 'api_key', in: 'query' },
          example: 'fbk_abc123...',
          description:
            'API key (alternative to dashboard cookie). Required for non-browser clients.',
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
      description: 'Missing or invalid cookie / api_key',
    },
  },
})

app.openapi(streamOrdersRoute, async (c) => {
  const authorized = await isAuthorized(
    c.env,
    c.req.header('cookie'),
    c.req.query('api_key'),
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

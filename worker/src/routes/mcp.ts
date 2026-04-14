// Model Context Protocol (MCP) endpoint — Streamable HTTP transport.
//
// Implements JSON-RPC 2.0 over a single POST endpoint so Claude Desktop and
// Claude Code can query FitKoh Bridge data as tools.
//
// We do NOT use `@modelcontextprotocol/sdk` here: the official SDK depends on
// Node built-ins (stdio, Express) that are not Workers-compatible, and pulling
// it in just for four simple tools would add unnecessary bundle weight. The
// Streamable HTTP transport is plain JSON-RPC, so a ~100-line hand-rolled
// implementation covers everything we need.
//
// Protocol reference:
//   https://spec.modelcontextprotocol.io/specification/basic/transports/#streamable-http

import { Hono } from 'hono'
import type { Env } from '../env'
import { verifyApiKey } from '../services/api-keys'
import {
  getAllBookings,
  getStats,
  getActivityLog,
} from '../db/queries'
import { getCachedOrFetchMeals } from '../services/meals-cache'
import type { ActivityType } from '@shared/types'

const app = new Hono<{ Bindings: Env }>()

// ---------------------------------------------------------------------------
// Server metadata
// ---------------------------------------------------------------------------

const SERVER_INFO = {
  name: 'fitkoh-bridge',
  version: '1.0.0',
}
const PROTOCOL_VERSION = '2024-11-05'

// ---------------------------------------------------------------------------
// Tool definitions — JSON Schema for inputs, description for the LLM
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'get_guest_meals',
    description:
      'Fetch meal items consumed by a specific guest on a given day. Returns product name, time, quantity, and price. Cached for 30s from Poster POS.',
    inputSchema: {
      type: 'object',
      properties: {
        posterClientId: {
          type: 'number',
          description: 'Poster POS client id for the guest',
        },
        date: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Target day in YYYY-MM-DD. Defaults to today (UTC).',
        },
      },
      required: ['posterClientId'],
    },
  },
  {
    name: 'list_guests',
    description:
      'List all guests (bookings) tracked by the bridge. Returns Clock booking id, guest name, room, Poster client id, check-in/out, and status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_stats',
    description:
      'Get bridge dashboard stats: total bookings, active, synced, unresolved dead letters, total charges posted.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_recent_activity',
    description:
      'Recent bridge events from the activity log. Optionally filter by type (booking_new, guest_created, checkout, charge_posted, error).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max number of entries to return (default 20, max 100).',
        },
        type: {
          type: 'string',
          enum: ['booking_new', 'guest_created', 'checkout', 'charge_posted', 'error'],
          description: 'Filter by activity type.',
        },
      },
    },
  },
]

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 helpers
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result }
}

function rpcError(id: JsonRpcId, error: JsonRpcError) {
  return { jsonrpc: '2.0' as const, id, error }
}

// ---------------------------------------------------------------------------
// Tool executor — returns MCP content blocks
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: 'text'
  text: string
}

interface ToolResult {
  content: ContentBlock[]
  isError?: boolean
}

function textBlock(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorBlock(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

async function callTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'get_guest_meals': {
      const posterClientId = Number(args.posterClientId)
      if (!Number.isFinite(posterClientId) || posterClientId <= 0) {
        return errorBlock('posterClientId is required and must be a positive number')
      }
      const date =
        (typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date)
          ? args.date
          : null) ?? new Date().toISOString().split('T')[0]

      const { data, fromCache } = await getCachedOrFetchMeals(env, posterClientId, date)
      if (data.items.length === 0) {
        return textBlock(
          `No meals found for Poster client ${posterClientId} on ${date}. (${fromCache ? 'cached' : 'fresh'})`,
        )
      }
      const lines = data.items.map(
        (i) =>
          `- ${i.time.slice(11, 16)}  ${i.productName} ×${i.quantity}  ${i.price} THB`,
      )
      const summary =
        `Guest ${posterClientId} — ${data.items.length} item(s) on ${date}, total ${data.total} THB` +
        ` (${fromCache ? 'cached' : 'fresh'}):\n${lines.join('\n')}`
      return textBlock(summary)
    }

    case 'list_guests': {
      const bookings = await getAllBookings(env.DB)
      if (bookings.length === 0) {
        return textBlock('No bookings in the bridge yet.')
      }
      const lines = bookings.map((b) => {
        const guest = b.guest_name ?? '(unnamed)'
        const room = b.room_number ? `Room ${b.room_number}` : 'no room'
        const poster = b.poster_client_id ?? '—'
        const stay =
          b.check_in && b.check_out ? `${b.check_in}→${b.check_out}` : 'no dates'
        return `- ${b.clock_booking_id}  ${guest}  ${room}  poster=${poster}  ${stay}  status=${b.status}  charges=${b.charge_count}`
      })
      return textBlock(`${bookings.length} guest(s):\n${lines.join('\n')}`)
    }

    case 'get_stats': {
      const s = await getStats(env.DB)
      const text =
        `Bridge stats:\n` +
        `- Total bookings: ${s.totalBookings}\n` +
        `- Active: ${s.activeBookings}\n` +
        `- Synced (checked out): ${s.syncedBookings}\n` +
        `- Unresolved dead letters: ${s.unresolvedDeadLetters}\n` +
        `- Total charges posted: ${s.totalChargesPosted}`
      return textBlock(text)
    }

    case 'get_recent_activity': {
      const rawLimit = Number(args.limit ?? 20)
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 100)
      const type = typeof args.type === 'string' ? (args.type as ActivityType) : undefined
      const entries = await getActivityLog(env.DB, { limit, offset: 0, type })
      if (entries.length === 0) {
        return textBlock(
          type ? `No recent activity of type "${type}".` : 'No recent activity.',
        )
      }
      const lines = entries.map(
        (e) =>
          `- [${e.created_at}] ${e.type}${e.booking_id ? ` (${e.booking_id})` : ''}: ${e.summary}`,
      )
      return textBlock(`${entries.length} event(s):\n${lines.join('\n')}`)
    }

    default:
      return errorBlock(`Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /mcp — discovery / info. Unauthenticated so Claude clients can probe it.
app.get('/', (c) =>
  c.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    description:
      'FitKoh Bridge MCP server — query bookings, guest meals, stats, and activity. ' +
      'Authenticate with Authorization: Bearer fbk_... or X-API-Key: fbk_...',
    transport: 'streamable-http',
    protocolVersion: PROTOCOL_VERSION,
    endpoint: '/mcp',
    methods: ['initialize', 'tools/list', 'tools/call'],
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
    docs: 'https://bridge.fitkoh.app/docs',
  }),
)

// POST /mcp — JSON-RPC handler. Authenticated.
app.post('/', async (c) => {
  // --- Auth ---
  const headerKey = c.req.header('x-api-key')
  const authHeader = c.req.header('authorization')
  const bearerKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  const key = headerKey || bearerKey

  if (!key) {
    return c.json(
      rpcError(null, {
        code: -32001,
        message: 'Missing API key. Provide via Authorization: Bearer or X-API-Key header.',
      }),
      401,
    )
  }
  const apiKey = await verifyApiKey(c.env.DB, key)
  if (!apiKey) {
    return c.json(
      rpcError(null, { code: -32001, message: 'Invalid or revoked API key' }),
      401,
    )
  }

  // --- Parse JSON-RPC request ---
  let body: JsonRpcRequest
  try {
    body = (await c.req.json()) as JsonRpcRequest
  } catch {
    return c.json(rpcError(null, { code: -32700, message: 'Parse error' }), 400)
  }
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return c.json(
      rpcError(body?.id ?? null, { code: -32600, message: 'Invalid Request' }),
      400,
    )
  }

  const id = body.id ?? null

  // --- Dispatch ---
  try {
    switch (body.method) {
      case 'initialize':
        return c.json(
          rpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          }),
        )

      case 'notifications/initialized':
      case 'notifications/cancelled':
        // Notifications have no response; id is absent.
        return c.body(null, 204)

      case 'tools/list':
        return c.json(rpcResult(id, { tools: TOOLS }))

      case 'tools/call': {
        const params = body.params ?? {}
        const name = String(params.name ?? '')
        const args = (params.arguments as Record<string, unknown>) ?? {}
        if (!name) {
          return c.json(
            rpcError(id, { code: -32602, message: 'Invalid params: missing tool name' }),
          )
        }
        const result = await callTool(c.env, name, args)
        return c.json(rpcResult(id, result))
      }

      case 'ping':
        return c.json(rpcResult(id, {}))

      default:
        return c.json(
          rpcError(id, { code: -32601, message: `Method not found: ${body.method}` }),
        )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    return c.json(rpcError(id, { code: -32603, message }))
  }
})

export default app

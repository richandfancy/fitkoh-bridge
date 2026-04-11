// Public API v1 — for external systems (FitKoh app, Homebase, etc.)
// Authenticated via X-API-Key header or Bearer token
// OpenAPI spec exposed at /openapi.json (unauthenticated)

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Env } from '../env'
import { apiKeyAuth, type V1Variables } from '../middleware/api-key'
import { getCachedOrFetchMeals } from '../services/meals-cache'
import { streamOrdersRoute } from './stream'

const app = new OpenAPIHono<{ Bindings: Env; Variables: V1Variables }>()

// Register the API key security scheme
app.openAPIRegistry.registerComponent('securitySchemes', 'ApiKeyAuth', {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
  description: 'API key issued by the FitKoh Bridge admin. Prefix with "fbk_".',
})

// Register the SSE streaming route in the main /api/v1/openapi.json spec.
// The actual handler lives in routes/stream.ts and is mounted at /api/v1/stream
// BEFORE v1 in index.ts, so it intercepts the request before apiKeyAuth runs.
// Here we only register the path for docs visibility — no handler attached.
app.openAPIRegistry.registerPath({
  ...streamOrdersRoute,
  path: '/stream/orders',
})

// Expose OpenAPI JSON spec BEFORE auth middleware so it is publicly reachable.
app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'FitKoh Bridge API',
    version: '1.0.0',
    description: [
      'Public API for FitKoh Bridge — cross-system data hub connecting Clock PMS, Poster POS, and consumer apps (FitKoh, Homebase).',
      '',
      '## Connecting from Claude (MCP)',
      '',
      'FitKoh Bridge also exposes a Model Context Protocol (MCP) endpoint at `/mcp` using the Streamable HTTP transport. This lets Claude Desktop and Claude Code query bridge data directly as tools.',
      '',
      '**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:',
      '```json',
      '{',
      '  "mcpServers": {',
      '    "fitkoh-bridge": {',
      '      "url": "https://bridge.fitkoh.app/mcp",',
      '      "headers": {',
      '        "Authorization": "Bearer fbk_YOUR_API_KEY"',
      '      }',
      '    }',
      '  }',
      '}',
      '```',
      '',
      '**Claude Code**:',
      '```bash',
      'claude mcp add fitkoh-bridge --transport http https://bridge.fitkoh.app/mcp \\',
      '  -H "Authorization: Bearer fbk_YOUR_API_KEY"',
      '```',
      '',
      'Available tools: `get_guest_meals`, `list_guests`, `get_stats`, `get_recent_activity`.',
    ].join('\n'),
  },
  servers: [
    { url: 'https://bridge.fitkoh.app', description: 'Production' },
    { url: 'https://s.bridge.fitkoh.app', description: 'Staging' },
    { url: 'http://localhost:8787', description: 'Local dev' },
  ],
})

// All other v1 routes require an API key
app.use('*', apiKeyAuth)

// ---------------------------------------------------------------------------
// Zod schemas (with OpenAPI metadata)
// ---------------------------------------------------------------------------

const MealItemSchema = z
  .object({
    id: z
      .string()
      .openapi({
        example: '157441-0',
        description: 'Stable item id: `<posterTransactionId>-<index>`',
      }),
    time: z
      .string()
      .openapi({
        example: '2026-04-11 08:44:03',
        description: 'Transaction close time as reported by Poster (local time).',
      }),
    posterProductId: z
      .string()
      .openapi({ example: '314', description: 'Poster product id' }),
    productName: z
      .string()
      .openapi({ example: 'Greek Yogurt Bowl', description: 'Human-readable product name' }),
    quantity: z.number().openapi({ example: 1 }),
    price: z.number().openapi({ example: 220, description: 'Unit price in minor currency units' }),
    fitkohMenuItemId: z
      .number()
      .nullable()
      .openapi({
        example: 42,
        description: 'Mapped FitKoh menu item id, or `null` if the Poster product is unmapped.',
      }),
  })
  .openapi('MealItem')

const MealsResponseSchema = z
  .object({
    posterClientId: z.number().openapi({ example: 2512 }),
    date: z.string().openapi({ example: '2026-04-07' }),
    items: z.array(MealItemSchema),
    total: z
      .number()
      .openapi({ example: 760, description: 'Sum of price * quantity across all items' }),
    cachedAt: z
      .string()
      .openapi({
        example: '2026-04-07T09:12:33.123Z',
        description: 'ISO 8601 timestamp at which the data was cached in D1.',
      }),
    fromCache: z
      .boolean()
      .openapi({
        example: true,
        description: 'True when the response was served from the D1 cache (age < 30s).',
      }),
  })
  .openapi('MealsResponse')

const HealthResponseSchema = z
  .object({
    ok: z.literal(true),
    apiKey: z.object({
      id: z.number().openapi({ example: 1 }),
      name: z.string().openapi({ example: 'FitKoh production' }),
    }),
    version: z.literal('v1'),
  })
  .openapi('HealthResponse')

const ErrorResponseSchema = z
  .object({
    error: z.string().openapi({ example: 'Invalid or revoked API key' }),
  })
  .openapi('ErrorResponse')

const PosterClientIdParam = z.object({
  posterClientId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'posterClientId', in: 'path' },
      example: 2512,
      description: 'Poster POS client id for the guest.',
    }),
})

const MealsQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional()
    .openapi({
      param: { name: 'date', in: 'query' },
      example: '2026-04-07',
      description: 'Target day in `YYYY-MM-DD`. Defaults to today (UTC).',
    }),
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const mealsRoute = createRoute({
  method: 'get',
  path: '/meals/{posterClientId}',
  tags: ['Meals'],
  summary: 'Get guest meals for a specific date',
  description:
    'Returns meal items (from Poster POS) consumed by a given guest on a specific day. Results are cached in D1 for up to 30 seconds to protect the upstream Poster API.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: PosterClientIdParam,
    query: MealsQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: MealsResponseSchema } },
      description: 'Meals for the requested guest and day',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Invalid parameters',
    },
    401: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Missing or invalid API key',
    },
    500: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Upstream (Poster) or bridge error',
    },
  },
})

app.openapi(mealsRoute, async (c) => {
  const { posterClientId } = c.req.valid('param')
  const { date: queryDate } = c.req.valid('query')
  const date = queryDate || new Date().toISOString().split('T')[0]

  try {
    const { data, fromCache } = await getCachedOrFetchMeals(c.env, posterClientId, date)
    return c.json(
      {
        ...data,
        fromCache,
      },
      200,
    )
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : 'Failed to fetch meals',
      },
      500,
    )
  }
})

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  summary: 'Verify that the API key is valid',
  description:
    "Lightweight public health check. Returns the caller's API key metadata — useful for consumers to verify their key is accepted.",
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: HealthResponseSchema } },
      description: 'API key is valid',
    },
    401: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Missing or invalid API key',
    },
  },
})

app.openapi(healthRoute, async (c) => {
  const apiKey = c.get('apiKey')
  return c.json(
    {
      ok: true as const,
      apiKey: { id: apiKey.id, name: apiKey.name },
      version: 'v1' as const,
    },
    200,
  )
})

export default app

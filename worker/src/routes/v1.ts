// Public API v1 — for external systems (FitKoh app, Homebase, etc.)
// Authenticated via X-API-Key header or Bearer token
// OpenAPI spec exposed at /openapi.json (unauthenticated)

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Env } from '../env'
import { apiKeyAuth, type V1Variables } from '../middleware/api-key'
import { getCachedOrFetchMeals } from '../services/meals-cache'
import { signJwt } from '../services/jwt'
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
    apiKey: z
      .object({
        id: z.number().openapi({ example: 1 }),
        name: z.string().openapi({ example: 'FitKoh production' }),
      })
      .optional()
      .openapi({ description: 'Present when authenticated via an API key' }),
    jwt: z
      .object({
        sub: z.number().openapi({ example: 2512, description: 'posterClientId' }),
        scope: z.string().openapi({ example: 'meals:read' }),
        exp: z.number().openapi({ example: 1712500000 }),
      })
      .optional()
      .openapi({ description: 'Present when authenticated via a bridge JWT' }),
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
    403: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'JWT scoped to a different guest',
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

  // JWT scope enforcement: a bridge JWT is locked to a single posterClientId
  // (the `sub` claim). API keys have full access and skip this check.
  const jwt = c.get('jwt')
  if (jwt && jwt.sub !== posterClientId) {
    return c.json({ error: 'JWT is scoped to a different posterClientId' }, 403)
  }

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
  const jwt = c.get('jwt')
  return c.json(
    {
      ok: true as const,
      ...(apiKey ? { apiKey: { id: apiKey.id, name: apiKey.name } } : {}),
      ...(jwt ? { jwt: { sub: jwt.sub, scope: jwt.scope, exp: jwt.exp } } : {}),
      version: 'v1' as const,
    },
    200,
  )
})

// ---------------------------------------------------------------------------
// POST /auth/token — issue a short-lived JWT scoped to one guest.
//
// Called by the FitKoh backend with its service API key. The returned JWT is
// sent to the browser and used for direct /meals/:posterClientId calls — so
// the master API key never leaves the server.
//
// Only API keys can issue tokens. JWT holders get 403 to prevent infinite
// self-renewal chains.
// ---------------------------------------------------------------------------

const TokenRequestSchema = z
  .object({
    posterClientId: z
      .number()
      .int()
      .positive()
      .openapi({ example: 2512, description: 'Poster POS client id for the guest' }),
    expiresIn: z
      .number()
      .int()
      .min(60)
      .max(86400)
      .default(3600)
      .openapi({
        example: 3600,
        description: 'Token lifetime in seconds (60 min … 24 h).',
      }),
  })
  .openapi('TokenRequest')

const TokenResponseSchema = z
  .object({
    token: z
      .string()
      .openapi({
        example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        description: 'Signed bridge JWT. Send as `Authorization: Bearer <token>`.',
      }),
    expiresAt: z
      .number()
      .openapi({
        example: 1712500000,
        description: 'Unix timestamp (seconds) when the token expires.',
      }),
    posterClientId: z.number().openapi({ example: 2512 }),
  })
  .openapi('TokenResponse')

const tokenRoute = createRoute({
  method: 'post',
  path: '/auth/token',
  tags: ['Auth'],
  summary: 'Issue a short-lived JWT scoped to a specific guest',
  description: [
    'Exchange a service API key for a short-lived JWT that can be used from',
    'the browser. The JWT is locked to the supplied `posterClientId` and can',
    'only fetch meals for that one guest.',
    '',
    'Only API keys can issue tokens — JWTs cannot self-renew.',
  ].join('\n'),
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: TokenRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: TokenResponseSchema } },
      description: 'Token issued',
    },
    401: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Missing or invalid API key',
    },
    403: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'JWTs cannot issue tokens',
    },
  },
})

app.openapi(tokenRoute, async (c) => {
  // Block JWT-authenticated callers from minting new tokens. Only master
  // API keys held server-side may issue tokens.
  if (c.get('jwt') && !c.get('apiKey')) {
    return c.json({ error: 'JWTs cannot issue tokens. Use an API key.' }, 403)
  }

  const { posterClientId, expiresIn } = c.req.valid('json')
  const token = await signJwt(
    c.env,
    { sub: posterClientId, scope: 'meals:read' },
    expiresIn,
  )

  return c.json(
    {
      token,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      posterClientId,
    },
    200,
  )
})

export default app

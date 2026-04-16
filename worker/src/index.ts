import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Scalar } from '@scalar/hono-api-reference'
import { captureException, withSentry } from '@sentry/cloudflare'
import type { Env } from './env'
import { dashboardAuth } from './middleware/auth'
import { docsAuth } from './middleware/docs-auth'
import auth from './routes/auth'
import api from './routes/api'
import webhooks from './routes/webhooks'
import admin from './routes/admin'
import v1 from './routes/v1'
import stream from './routes/stream'
import mcp from './routes/mcp'
import { warmMealsCache, warmOrdersSnapshot } from './services/cache-warmer'
import { autoImportNewMeals } from './services/auto-importer'
import { getCronHealth, recordCronSuccess } from './services/cron-health'

const app = new Hono<{ Bindings: Env }>()

// ---------------------------------------------------------------------------
// CORS — only /api/v1/* and /mcp/* are browser-callable. Dashboard routes
// stay same-origin only (no CORS), since they use cookie auth and are only
// served from the bridge's own domain.
// Localhost origins are only allowed in non-production environments.
// ---------------------------------------------------------------------------
const PROD_ORIGINS = ['https://fitkoh.app', 'https://s.fitkoh.app']
const DEV_ORIGINS = [...PROD_ORIGINS, 'http://localhost:5173', 'http://localhost:3000']

function createCorsMiddleware() {
  return async (c: any, next: any) => {
    const origins = c.env.ENVIRONMENT === 'production' ? PROD_ORIGINS : DEV_ORIGINS
    return cors({
      origin: (origin: string) => origins.includes(origin) ? origin : null,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      maxAge: 3600,
      credentials: false,
    })(c, next)
  }
}

app.use('/api/v1/*', createCorsMiddleware())
app.use('/mcp', createCorsMiddleware())
app.use('/mcp/*', createCorsMiddleware())

// Health check. Reports stale cron heartbeat when no successful tick happened
// in the last 180 seconds (BAC-1093).
app.get('/api/health', async (c) => {
  const cronHealth = await getCronHealth(c.env)
  return c.json({
    ok: !cronHealth.staleCron,
    environment: c.env.ENVIRONMENT,
    stale_cron: cronHealth.staleCron,
    last_cron_ok_at: cronHealth.lastCronOkAt,
    cron_age_seconds: cronHealth.cronAgeSeconds,
  })
})

// Docs and schema are gated behind HTTP Basic auth so the API surface
// isn't discoverable to anyone who stumbles on the domain.
app.use('/docs', docsAuth)
app.use('/api/v1/openapi.json', docsAuth)

// Scalar API reference UI (behind docs auth)
app.get(
  '/docs',
  Scalar({
    url: '/api/v1/openapi.json',
    theme: 'default',
    layout: 'modern',
    pageTitle: 'FitKoh Bridge API',
  }),
)

// SSE streaming endpoints — mounted BEFORE /api/v1 so requests to
// /api/v1/stream/* are handled here (cookie OR ?api_key= auth) instead of
// being caught by the v1 sub-app's X-API-Key-only middleware.
app.route('/api/v1/stream', stream)

// Public API v1 (authenticated via X-API-Key header)
// For external systems: FitKoh app, Homebase, etc.
// Note: /api/v1/openapi.json is registered on the v1 sub-app BEFORE the
// apiKeyAuth middleware, so it remains publicly reachable.
app.route('/api/v1', v1)

// MCP (Model Context Protocol) endpoint — Streamable HTTP transport.
// GET /mcp returns a public discovery JSON; POST /mcp handles JSON-RPC.
app.route('/mcp', mcp)

// Auth routes (login/logout/check — no middleware)
app.route('/', auth)

// Webhook routes — gated behind dashboard auth until real Clock PMS integration
// goes live. When Clock credentials arrive, replace dashboardAuth with SNS
// signature verification (validate the x-amz-sns-* headers + signing cert).
app.use('/api/webhooks/*', dashboardAuth)
app.route('/api/webhooks', webhooks)

// Dashboard API routes (protected by cookie auth)
app.use('/api/dashboard/*', dashboardAuth)
app.route('/api/dashboard', api)

// Admin routes (protected by cookie auth)
app.use('/api/admin/*', dashboardAuth)
app.route('/api/admin', admin)

// Export as a handler object so Cloudflare invokes the `scheduled` function
// on every Cron Trigger tick. The `fetch` handler keeps the Hono app routing
// exactly as before — any issue in the cron path must not break HTTP traffic.
const handler = {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        let hasError = false

        await warmMealsCache(env).catch((err) => {
          hasError = true
          console.error('Cache warm failed:', err)
          captureException(err instanceof Error ? err : new Error(String(err)), {
            tags: { subsystem: 'cron', step: 'warmMealsCache' },
          })
        })
        await warmOrdersSnapshot(env).catch((err) => {
          hasError = true
          console.error('Orders snapshot warm failed:', err)
          captureException(err instanceof Error ? err : new Error(String(err)), {
            tags: { subsystem: 'cron', step: 'warmOrdersSnapshot' },
          })
        })
        await autoImportNewMeals(env).catch((err) => {
          hasError = true
          console.error('Auto-import failed:', err)
          captureException(err instanceof Error ? err : new Error(String(err)), {
            tags: { subsystem: 'cron', step: 'autoImportNewMeals' },
          })
        })

        if (!hasError) {
          await recordCronSuccess(env).catch((err) => {
            console.error('Cron heartbeat write failed:', err)
          })
        }
      })(),
    )
  },
}

export default withSentry(
  (env: Env) => env.SENTRY_DSN
    ? { dsn: env.SENTRY_DSN, environment: env.ENVIRONMENT, tracesSampleRate: 0 }
    : undefined,
  handler,
)

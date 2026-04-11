import { Hono } from 'hono'
import { Scalar } from '@scalar/hono-api-reference'
import type { Env } from './env'
import { dashboardAuth } from './middleware/auth'
import auth from './routes/auth'
import api from './routes/api'
import webhooks from './routes/webhooks'
import admin from './routes/admin'
import v1 from './routes/v1'

const app = new Hono<{ Bindings: Env }>()

// Health check
app.get('/api/health', (c) => {
  return c.json({ ok: true, environment: c.env.ENVIRONMENT })
})

// Scalar API reference UI (public, reads /api/v1/openapi.json)
app.get(
  '/docs',
  Scalar({
    url: '/api/v1/openapi.json',
    theme: 'default',
    layout: 'modern',
    pageTitle: 'FitKoh Bridge API',
  }),
)

// Public API v1 (authenticated via X-API-Key header)
// For external systems: FitKoh app, Homebase, etc.
// Note: /api/v1/openapi.json is registered on the v1 sub-app BEFORE the
// apiKeyAuth middleware, so it remains publicly reachable.
app.route('/api/v1', v1)

// Auth routes (login/logout/check — no middleware)
app.route('/', auth)

// Webhook routes (authenticated via their own mechanism)
app.route('/api/webhooks', webhooks)

// Dashboard API routes (protected by cookie auth)
app.use('/api/dashboard/*', dashboardAuth)
app.route('/api/dashboard', api)

// Admin routes (protected by cookie auth)
app.use('/api/admin/*', dashboardAuth)
app.route('/api/admin', admin)

export default app

import { Hono } from 'hono'
import type { Env } from '../env'
import type { BridgeEvent, WebhookSubscription } from '@shared/types'
import { seedDatabase } from '../services/clock-mock'
import { getClockClient } from '../services/clock-factory'
import { transferInvoice } from '../services/invoice-transfer'
import { getBookingDetail } from '../db/queries'
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../services/api-keys'
import { warmMealsCache } from '../services/cache-warmer'
import { autoImportNewMeals } from '../services/auto-importer'
import {
  clearSubscriptionCache,
  dispatchEvent,
  generateEventId,
} from '../services/webhook-dispatcher'

const app = new Hono<{ Bindings: Env }>()

// Manual sync trigger
app.post('/sync/:clockBookingId', async (c) => {
  const bookingId = c.req.param('clockBookingId')
  const clock = getClockClient(c.env)
  await transferInvoice(c.env, clock, bookingId)
  return c.json({ ok: true, bookingId })
})

// Booking sync status
app.get('/sync/:clockBookingId/status', async (c) => {
  const bookingId = c.req.param('clockBookingId')
  const detail = await getBookingDetail(c.env.DB, bookingId)
  if (!detail) return c.json({ error: 'Booking not found' }, 404)
  return c.json(detail)
})

// Reset sync (clear synced_transactions for re-billing)
app.post('/sync/:clockBookingId/reset', async (c) => {
  const bookingId = c.req.param('clockBookingId')
  await c.env.DB.prepare(
    'DELETE FROM synced_transactions WHERE clock_booking_id = ?',
  )
    .bind(bookingId)
    .run()
  await c.env.DB.prepare(
    "UPDATE bookings SET status = 'active' WHERE clock_booking_id = ?",
  )
    .bind(bookingId)
    .run()
  return c.json({ ok: true, bookingId })
})

// Seed database (dev only)
app.post('/seed', async (c) => {
  if (c.env.ENVIRONMENT === 'production') {
    return c.json({ error: 'Seed is disabled in production' }, 403)
  }
  await seedDatabase(c.env.DB)
  return c.json({ ok: true, message: 'Database seeded with mock data' })
})

// API key management
app.get('/api-keys', async (c) => {
  const keys = await listApiKeys(c.env.DB)
  return c.json(keys)
})

app.post('/api-keys', async (c) => {
  const body = await c.req.json<{ name?: string }>()
  if (!body.name || body.name.trim().length === 0) {
    return c.json({ error: 'Name is required' }, 400)
  }
  const result = await createApiKey(c.env.DB, body.name.trim())
  // The raw key is ONLY returned here on creation — client must save it
  return c.json(result)
})

app.post('/api-keys/:id/revoke', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || isNaN(id)) return c.json({ error: 'Invalid id' }, 400)
  await revokeApiKey(c.env.DB, id)
  return c.json({ ok: true })
})

// Manual cache warm trigger — mirrors the Cron handler. Useful for testing
// in `wrangler dev` (which does not fire cron triggers) and for ops when we
// need to force-refresh the cache without waiting for the next tick.
app.post('/warm-cache', async (c) => {
  const result = await warmMealsCache(c.env)
  return c.json(result)
})

// Manual auto-import trigger — runs the same logic as the cron handler.
// Useful for testing and for forcing an immediate import.
app.post('/auto-import', async (c) => {
  const result = await autoImportNewMeals(c.env)
  return c.json(result)
})

// ---------------------------------------------------------------------------
// Webhook subscription CRUD
// ---------------------------------------------------------------------------

// List webhook subscriptions
app.get('/webhooks', async (c) => {
  const subs = await c.env.DB.prepare('SELECT * FROM webhook_subscriptions ORDER BY created_at DESC').all<WebhookSubscription>()
  return c.json(subs.results)
})

// Create webhook subscription
app.post('/webhooks', async (c) => {
  const body = await c.req.json<{
    url: string
    events: string[]
    description?: string
  }>()

  if (!body.url || !body.events?.length) {
    return c.json({ error: 'url and events[] required' }, 400)
  }

  // Generate a signing secret
  const secret = crypto.randomUUID()

  const result = await c.env.DB.prepare(
    'INSERT INTO webhook_subscriptions (url, events, secret, description) VALUES (?, ?, ?, ?) RETURNING id, secret'
  ).bind(body.url, JSON.stringify(body.events), secret, body.description || null).first<{ id: number; secret: string }>()

  clearSubscriptionCache()

  // Return the secret ONCE -- consumer must save it for signature verification
  return c.json({
    id: result!.id,
    secret: result!.secret,
    url: body.url,
    events: body.events,
  })
})

// Delete webhook subscription
app.delete('/webhooks/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').bind(id).run()
  clearSubscriptionCache()
  return c.json({ ok: true })
})

// Toggle webhook active/inactive
app.post('/webhooks/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('UPDATE webhook_subscriptions SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END, failure_count = 0 WHERE id = ?').bind(id).run()
  clearSubscriptionCache()
  return c.json({ ok: true })
})

// Test webhook (send a test event)
app.post('/webhooks/:id/test', async (c) => {
  const id = Number(c.req.param('id'))
  const sub = await c.env.DB.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?').bind(id).first<WebhookSubscription>()
  if (!sub) return c.json({ error: 'Not found' }, 404)

  const testEvent: BridgeEvent = {
    id: generateEventId(),
    type: 'meal.ordered',
    timestamp: new Date().toISOString(),
    data: {
      posterClientId: 0,
      posterProductId: '0',
      productName: 'Test Event',
      quantity: 1,
      price: 0,
      fitkohMenuItemId: null,
      transactionId: 0,
      time: new Date().toISOString(),
    },
  }

  // Dispatch to just this one subscription (uses the general dispatcher)
  const result = await dispatchEvent(c.env, testEvent)
  return c.json({ ...result, event: testEvent })
})

export default app

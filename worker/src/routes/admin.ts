import { Hono } from 'hono'
import type { Env } from '../env'
import { MockClockClient, seedDatabase } from '../services/clock-mock'
import { transferInvoice } from '../services/invoice-transfer'
import { getBookingDetail } from '../db/queries'
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../services/api-keys'
import { warmMealsCache } from '../services/cache-warmer'
import { autoImportNewMeals } from '../services/auto-importer'

const app = new Hono<{ Bindings: Env }>()

// Manual sync trigger
app.post('/sync/:clockBookingId', async (c) => {
  const bookingId = c.req.param('clockBookingId')
  const clock = new MockClockClient()
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

export default app

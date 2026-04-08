import { Hono } from 'hono'
import type { Env } from '../env'
import { MockClockClient, seedDatabase } from '../services/clock-mock'
import { transferInvoice } from '../services/invoice-transfer'
import { getBookingDetail } from '../db/queries'

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

export default app

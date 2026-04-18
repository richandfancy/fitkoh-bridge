import { Hono } from 'hono'
import type { Env } from '../env'
import type { SNSWebhookPayload } from '@shared/types'
import { getClockClient } from '../services/clock-factory'
import { syncGuest } from '../services/guest-sync'
import { transferInvoice } from '../services/invoice-transfer'
import { logActivity } from '../db/queries'

const app = new Hono<{ Bindings: Env }>()

app.post('/clock', async (c) => {
  // Parse SNS envelope
  const body = await c.req.json<SNSWebhookPayload>()
  const eventType = body.Subject
  const message = JSON.parse(body.Message) as { booking_id?: number }
  const bookingId = String(message.booking_id || '')

  if (!bookingId) {
    return c.json({ error: 'Missing booking_id' }, 400)
  }

  // Falls back to the mock Clock client until real credentials arrive
  const clock = getClockClient(c.env)

  switch (eventType) {
    case 'booking_new':
      await logActivity(c.env.DB, {
        type: 'booking_new',
        booking_id: bookingId,
        summary: `Received booking_new webhook for booking #${bookingId}`,
        payload: JSON.stringify(body),
      })
      await syncGuest(c.env, clock, bookingId)
      break

    case 'booking_checked_out':
      await logActivity(c.env.DB, {
        type: 'checkout',
        booking_id: bookingId,
        summary: `Received checkout webhook for booking #${bookingId}`,
        payload: JSON.stringify(body),
      })
      await transferInvoice(c.env, clock, bookingId)
      break

    default:
      // Log but don't act on other events
      await logActivity(c.env.DB, {
        type: 'booking_new',
        booking_id: bookingId,
        summary: `Received ${eventType} webhook for booking #${bookingId} (no action)`,
        payload: JSON.stringify(body),
      })
  }

  return c.json({ ok: true })
})

export default app

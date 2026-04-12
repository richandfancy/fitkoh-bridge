import { Hono } from 'hono'
import type { Env } from '../env'
import { createSessionToken, verifySessionToken } from '../lib/crypto'

const auth = new Hono<{ Bindings: Env }>()

auth.post('/api/auth/login', async (c) => {
  const body = await c.req.json<{ secret: string }>()

  if (!body.secret || body.secret !== c.env.DASHBOARD_SECRET) {
    return c.json({ error: 'Invalid secret' }, 401)
  }

  const isProduction = c.env.ENVIRONMENT === 'production'

  // Generate an HMAC-signed session token instead of storing the raw secret.
  // The cookie value is opaque: `{timestamp}.{hmac_hex}`.
  const sessionToken = await createSessionToken(c.env.DASHBOARD_SECRET)

  return c.json(
    { ok: true },
    200,
    {
      'Set-Cookie': [
        `bridge_session=${sessionToken}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${60 * 60 * 24 * 30}`, // 30 days (matches token expiry)
        isProduction ? 'Secure' : '',
      ]
        .filter(Boolean)
        .join('; '),
    },
  )
})

auth.post('/api/auth/logout', async (c) => {
  return c.json(
    { ok: true },
    200,
    {
      'Set-Cookie': [
        'bridge_session=',
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        'Max-Age=0',
      ].join('; '),
    },
  )
})

auth.get('/api/auth/check', async (c) => {
  const cookie = c.req.header('cookie')
  const sessionValue = cookie
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('bridge_session='))
    ?.split('=')[1]

  if (!sessionValue) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const valid = await verifySessionToken(c.env.DASHBOARD_SECRET, sessionValue)
  if (!valid) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  return c.json({ ok: true })
})

export default auth

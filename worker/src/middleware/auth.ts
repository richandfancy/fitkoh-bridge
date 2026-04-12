import { createMiddleware } from 'hono/factory'
import type { Env } from '../env'
import { verifySessionToken } from '../lib/crypto'

export const dashboardAuth = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
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

    await next()
  },
)

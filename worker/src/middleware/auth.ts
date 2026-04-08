import { createMiddleware } from 'hono/factory'
import type { Env } from '../env'

export const dashboardAuth = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const cookie = c.req.header('cookie')
    const sessionValue = cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('bridge_session='))
      ?.split('=')[1]

    if (!sessionValue || sessionValue !== c.env.DASHBOARD_SECRET) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  },
)

import { createMiddleware } from 'hono/factory'
import type { Env } from '../env'
import { verifyApiKey, type ApiKey } from '../services/api-keys'

export type V1Variables = {
  apiKey: ApiKey
}

export const apiKeyAuth = createMiddleware<{
  Bindings: Env
  Variables: V1Variables
}>(async (c, next) => {
  const headerKey = c.req.header('x-api-key')
  const authHeader = c.req.header('authorization')
  const bearerKey = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null

  const key = headerKey || bearerKey

  if (!key) {
    return c.json(
      { error: 'Missing API key. Provide via X-API-Key header or Bearer token.' },
      401,
    )
  }

  const apiKey = await verifyApiKey(c.env.DB, key)
  if (!apiKey) {
    return c.json({ error: 'Invalid or revoked API key' }, 401)
  }

  // Attach to context for downstream handlers
  c.set('apiKey', apiKey)
  await next()
})

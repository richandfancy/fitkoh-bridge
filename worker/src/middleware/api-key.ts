import { createMiddleware } from 'hono/factory'
import type { Env } from '../env'
import { verifyApiKey, type ApiKey } from '../services/api-keys'
import { verifyJwt, type BridgeJwtPayload } from '../services/jwt'

// V1 auth context — a request is either authenticated via an API key OR a
// bridge JWT. Downstream handlers can inspect both to decide scope/access.
// `apiKeyScopes` is set whenever an API key authenticated the request, so
// handlers can gate behavior with `hasScope()` without re-reading the row.
export type V1Variables = {
  apiKey?: ApiKey
  apiKeyScopes?: string[]
  jwt?: BridgeJwtPayload
}

export const apiKeyAuth = createMiddleware<{
  Bindings: Env
  Variables: V1Variables
}>(async (c, next) => {
  const headerKey = c.req.header('x-api-key')
  const authHeader = c.req.header('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null

  // 1. Try JWT first if the bearer token looks like one (starts with "ey").
  //    JWTs are the preferred browser-side auth (via /api/v1/auth/token).
  if (bearerToken && bearerToken.startsWith('ey')) {
    const payload = await verifyJwt(c.env, bearerToken)
    if (payload) {
      c.set('jwt', payload)
      return next()
    }
    // Fall through — maybe it happens to start with "ey" but is actually a key.
  }

  // 2. Fall back to API key auth (either X-API-Key header or Bearer fbk_...).
  const key =
    headerKey || (bearerToken?.startsWith('fbk_') ? bearerToken : null)

  if (!key) {
    return c.json(
      {
        error:
          'Missing API key or JWT. Provide via X-API-Key header or Authorization: Bearer.',
      },
      401,
    )
  }

  const apiKey = await verifyApiKey(c.env.DB, key)
  if (!apiKey) {
    return c.json({ error: 'Invalid or revoked API key' }, 401)
  }

  c.set('apiKey', apiKey)
  c.set('apiKeyScopes', apiKey.scopes)
  await next()
})

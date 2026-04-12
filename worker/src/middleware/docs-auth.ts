import { createMiddleware } from 'hono/factory'
import type { Env } from '../env'

/**
 * HTTP Basic auth middleware for the API docs.
 *
 * The schema/docs are gated so the API surface isn't discoverable by anyone
 * who stumbles on the domain. Actual data endpoints still require an API key
 * (this is purely an extra layer for /docs and /api/v1/openapi.json).
 *
 * Username is hardcoded to "admin" — the DOCS_PASSWORD secret is what matters.
 * In dev, if DOCS_PASSWORD is not set, we fall back to a dev password.
 */
export const docsAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (!c.env.DOCS_PASSWORD && c.env.ENVIRONMENT === 'production') {
    throw new Error('DOCS_PASSWORD must be set in production')
  }
  const expectedPassword = c.env.DOCS_PASSWORD || 'dev-docs-password'

  const authHeader = c.req.header('authorization')
  if (!authHeader?.startsWith('Basic ')) {
    return new Response('Authentication required', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="FitKoh Bridge Docs"',
      },
    })
  }

  try {
    const decoded = atob(authHeader.slice(6))
    const separatorIdx = decoded.indexOf(':')
    if (separatorIdx === -1) {
      return new Response('Invalid credentials', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="FitKoh Bridge Docs"',
        },
      })
    }
    const password = decoded.slice(separatorIdx + 1)

    // Constant-time comparison to avoid timing attacks
    if (!constantTimeEqual(password, expectedPassword)) {
      return new Response('Invalid credentials', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="FitKoh Bridge Docs"',
        },
      })
    }
  } catch {
    return new Response('Invalid credentials', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="FitKoh Bridge Docs"',
      },
    })
  }

  await next()
})

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

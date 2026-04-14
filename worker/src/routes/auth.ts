import { Hono } from 'hono'
import type { Env } from '../env'
import {
  createMagicLinkToken,
  createSessionToken,
  verifyMagicLinkToken,
  verifySessionToken,
} from '../lib/crypto'

const auth = new Hono<{ Bindings: Env }>()

// ---------------------------------------------------------------------------
// Magic-link login (BAC-1080)
//
// Replaces the old shared-secret `POST /api/auth/login`. Flow:
//   1. Client POSTs email to /api/auth/request-link.
//   2. If email is on BRIDGE_ADMIN_EMAILS allowlist, worker signs a token and
//      emails a link to /auth/callback?token=<token> via Resend.
//   3. User clicks link. GET /auth/callback verifies the token, sets the
//      bridge_session cookie, and 302s to /.
//
// The response to /api/auth/request-link never reveals whether the email was
// on the allowlist (no oracle). Rate-limited per email to 5 requests / 15min.
// ---------------------------------------------------------------------------

const REQUEST_WINDOW_MS = 15 * 60 * 1000
const REQUEST_MAX_PER_WINDOW = 5

// In-memory rate-limit map keyed by lowercase email.
// Reset on Worker cold start — acceptable for a low-volume admin-only route.
const requestAttempts = new Map<string, number[]>()

function isRateLimited(email: string): boolean {
  const now = Date.now()
  const prior = requestAttempts.get(email) ?? []
  const recent = prior.filter((ts) => now - ts < REQUEST_WINDOW_MS)
  if (recent.length >= REQUEST_MAX_PER_WINDOW) {
    requestAttempts.set(email, recent)
    return true
  }
  recent.push(now)
  requestAttempts.set(email, recent)
  return false
}

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  )
}

function buildCallbackUrl(c: {
  req: { url: string }
  env: Env
}, token: string): string {
  // Use the request's own origin so staging/prod/localhost all work.
  const origin = new URL(c.req.url).origin
  return `${origin}/auth/callback?token=${encodeURIComponent(token)}`
}

function sessionCookieHeader(isProduction: boolean, token: string): string {
  return [
    `bridge_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${60 * 60 * 24 * 30}`, // 30 days (matches session token expiry)
    isProduction ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

async function sendMagicLinkEmail(
  env: Env,
  to: string,
  link: string,
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not configured')
  }

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0a0a0a;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#e5e5e5;">
    <div style="max-width:480px;margin:0 auto;background:#151515;border:1px solid #2a2a2a;border-radius:12px;padding:32px;">
      <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;color:#fafafa;">Sign in to FitKoh Bridge</h1>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#a3a3a3;">Click the button below to finish signing in. This link expires in 15 minutes and can only be used once.</p>
      <a href="${link}" style="display:inline-block;padding:12px 20px;background:#ffffff;color:#0a0a0a;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Sign in</a>
      <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#737373;">If the button doesn't work, paste this URL into your browser:<br><span style="color:#a3a3a3;word-break:break-all;">${link}</span></p>
      <p style="margin:20px 0 0;font-size:12px;color:#737373;">Didn't request this? You can safely ignore this email.</p>
    </div>
  </body>
</html>`

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'FitKoh Bridge <bridge@fitkoh.app>',
      to: [to],
      subject: 'Sign in to FitKoh Bridge',
      html,
    }),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Resend API error: ${resp.status} ${body.slice(0, 200)}`)
  }
}

auth.post('/api/auth/request-link', async (c) => {
  let body: { email?: string }
  try {
    body = await c.req.json<{ email?: string }>()
  } catch {
    return c.json({ ok: false, error: 'invalid_body' }, 400)
  }

  const email = (body.email ?? '').trim().toLowerCase()
  if (!email || !email.includes('@')) {
    return c.json({ ok: false, error: 'invalid_email' }, 400)
  }

  if (isRateLimited(email)) {
    return c.json({ ok: false, error: 'rate_limited' }, 429)
  }

  const allowlist = parseAllowlist(c.env.BRIDGE_ADMIN_EMAILS)

  // Don't leak allowlist membership — always return {ok: true} for valid-looking
  // emails, whether or not we actually send mail.
  if (allowlist.size === 0 || !allowlist.has(email)) {
    return c.json({ ok: true })
  }

  try {
    const token = await createMagicLinkToken(c.env.DASHBOARD_SECRET, email)
    const link = buildCallbackUrl(c, token)
    await sendMagicLinkEmail(c.env, email, link)
  } catch (err) {
    console.error('Magic link send failed:', err)
    return c.json({ ok: false, error: 'send_failed' }, 500)
  }

  return c.json({ ok: true })
})

auth.get('/auth/callback', async (c) => {
  const token = c.req.query('token')
  const origin = new URL(c.req.url).origin

  if (!token) {
    return c.redirect(`${origin}/?auth_error=invalid`, 302)
  }

  const verified = await verifyMagicLinkToken(c.env.DASHBOARD_SECRET, token)
  if (!verified) {
    return c.redirect(`${origin}/?auth_error=expired`, 302)
  }

  const allowlist = parseAllowlist(c.env.BRIDGE_ADMIN_EMAILS)
  if (!allowlist.has(verified.email)) {
    return c.redirect(`${origin}/?auth_error=not_allowlisted`, 302)
  }

  const isProduction = c.env.ENVIRONMENT === 'production'
  const sessionToken = await createSessionToken(c.env.DASHBOARD_SECRET)

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${origin}/`,
      'Set-Cookie': sessionCookieHeader(isProduction, sessionToken),
    },
  })
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

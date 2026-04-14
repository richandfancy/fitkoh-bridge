// Shared HMAC-SHA256 helper for cookie session tokens and other signing needs.
// Uses the Web Crypto API (available natively in Cloudflare Workers).

const encoder = new TextEncoder()

/**
 * Compute an HMAC-SHA256 signature and return it as a lowercase hex string.
 */
export async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Session token expiry: 30 days in milliseconds.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Create a signed session token: `{timestamp}.{hmac}`.
 * The timestamp records when the session was created; the HMAC proves it was
 * issued by someone who knew DASHBOARD_SECRET without revealing the secret.
 */
export async function createSessionToken(secret: string): Promise<string> {
  const ts = String(Date.now())
  const sig = await hmacSha256(secret, `bridge_session:${ts}`)
  return `${ts}.${sig}`
}

/**
 * Verify a session token. Returns `true` if the HMAC is valid and the token
 * has not expired (30 days).
 */
export async function verifySessionToken(
  secret: string,
  token: string,
): Promise<boolean> {
  const dotIndex = token.indexOf('.')
  if (dotIndex === -1) return false

  const ts = token.substring(0, dotIndex)
  const sig = token.substring(dotIndex + 1)

  if (!ts || !sig) return false

  // Check expiry
  const age = Date.now() - Number(ts)
  if (Number.isNaN(age) || age < 0 || age > SESSION_MAX_AGE_MS) return false

  const expected = await hmacSha256(secret, `bridge_session:${ts}`)
  // Constant-time comparison to avoid timing attacks
  if (expected.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  }
  return diff === 0
}

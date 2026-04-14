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
  return constantTimeEqual(expected, sig)
}

/**
 * Constant-time string comparison to avoid timing attacks.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// Magic link token expiry: 15 minutes in milliseconds.
const MAGIC_LINK_MAX_AGE_MS = 15 * 60 * 1000

/**
 * Base64url-encode a UTF-8 string (no padding). Safe for URL query params.
 */
function base64UrlEncode(value: string): string {
  const bytes = encoder.encode(value)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Base64url-decode back to a UTF-8 string. Returns null on malformed input.
 */
function base64UrlDecode(value: string): string | null {
  try {
    let padded = value.replace(/-/g, '+').replace(/_/g, '/')
    while (padded.length % 4) padded += '='
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/**
 * Create a magic-link token: `{email_b64url}.{expiresMs}.{hmac_hex}`.
 * Signed with DASHBOARD_SECRET so the server can verify it without storage.
 * Expires 15 minutes after issue.
 */
export async function createMagicLinkToken(
  secret: string,
  email: string,
): Promise<string> {
  const expiresMs = Date.now() + MAGIC_LINK_MAX_AGE_MS
  const emailB64 = base64UrlEncode(email)
  const sig = await hmacSha256(secret, `magic:${email}.${expiresMs}`)
  return `${emailB64}.${expiresMs}.${sig}`
}

/**
 * Verify a magic-link token. Returns the email on success, null on failure
 * (malformed, expired, or bad signature). Does NOT check allowlist — callers
 * must do that separately after decoding.
 */
export async function verifyMagicLinkToken(
  secret: string,
  token: string,
): Promise<{ email: string } | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [emailB64, expiresMsStr, sig] = parts
  if (!emailB64 || !expiresMsStr || !sig) return null

  const email = base64UrlDecode(emailB64)
  if (!email) return null

  const expiresMs = Number(expiresMsStr)
  if (!Number.isFinite(expiresMs) || expiresMs <= 0) return null
  if (Date.now() > expiresMs) return null

  const expected = await hmacSha256(secret, `magic:${email}.${expiresMs}`)
  if (!constantTimeEqual(expected, sig)) return null

  return { email }
}

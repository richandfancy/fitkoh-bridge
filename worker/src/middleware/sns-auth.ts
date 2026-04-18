import type { Context, Next } from 'hono'
import type { Env } from '../env'

// STUB — AWS SNS signature verification.
// Real implementation MUST:
//   1. Fetch the SigningCertURL from the payload, validate its CN is *.amazonaws.com.
//   2. Build the canonical string-to-sign per
//      https://docs.aws.amazon.com/sns/latest/dg/sns-message-and-json-formats.html
//   3. RSA-verify the Signature (base64) using the cert's public key.
// Until that's in, this stub enforces the bare minimum so the endpoint can't
// be called with a random POST body.
export async function snsSignatureAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const messageType = c.req.header('x-amz-sns-message-type')
  if (!messageType) {
    return c.json({ error: 'missing x-amz-sns-message-type header' }, 400)
  }
  if (!['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'].includes(messageType)) {
    return c.json({ error: 'invalid x-amz-sns-message-type' }, 400)
  }
  // TODO(BAC-XXXX-real): fetch SigningCertURL, validate CN, verify Signature.
  await next()
}

import type { Env } from '../env'

export async function sendAlert(
  env: Env,
  subject: string,
  body: string,
): Promise<void> {
  if (!env.RESEND_API_KEY) return // Skip in dev

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'FitKoh Bridge <bridge@fitkoh.app>',
        to: ['pavel@fitkoh.app'], // configurable later via KV
        subject: `[Bridge] ${subject}`,
        text: body,
      }),
    })
  } catch {
    // Don't throw on notification failure -- log and continue
    console.error('Failed to send alert email')
  }
}

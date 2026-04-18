import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Loader2 } from 'lucide-react'

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  expired: 'That sign-in link has expired. Request a new one below.',
  invalid: "That sign-in link wasn't valid. Request a new one below.",
  not_allowlisted: "That email isn't authorized to access the dashboard.",
  reused: 'That sign-in link has already been used. Request a new one below.',
}

function readAuthErrorFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const reason = params.get('auth_error')
  if (!reason) return null
  // Clean the query param so the error doesn't stick on refresh.
  params.delete('auth_error')
  const qs = params.toString()
  const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
  window.history.replaceState({}, '', newUrl)
  return AUTH_ERROR_MESSAGES[reason] ?? 'Sign-in failed. Try again.'
}

export function LoginScreen() {
  const { requestMagicLink } = useAuth()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const initialError = readAuthErrorFromUrl()
    if (initialError) setError(initialError)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const trimmed = email.trim().toLowerCase()
    const result = await requestMagicLink(trimmed)
    setLoading(false)

    if (result.ok) {
      setSubmittedEmail(trimmed)
      return
    }

    if (result.error === 'rate_limited') {
      setError('Too many requests — try again in a few minutes.')
    } else if (result.error === 'invalid_email') {
      setError('Enter a valid email address.')
    } else {
      setError("Couldn't send the sign-in email. Try again.")
    }
  }

  if (submittedEmail) {
    return (
      <div className="min-h-dvh bg-background flex items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center mx-auto">
            <span className="text-primary-foreground font-bold text-2xl">FB</span>
          </div>
          <h1 className="text-xl font-semibold text-foreground">Check your email</h1>
          <p className="text-sm text-muted-foreground">
            If <span className="text-foreground">{submittedEmail}</span> is authorized, you'll get a
            sign-in link shortly. The link expires in 15 minutes.
          </p>
          <button
            type="button"
            onClick={() => {
              setSubmittedEmail(null)
              setEmail('')
            }}
            className="text-sm text-muted-foreground underline hover:text-foreground"
          >
            Use a different email
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-background flex items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div className="text-center space-y-2">
          <div className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center mx-auto">
            <span className="text-primary-foreground font-bold text-2xl">FB</span>
          </div>
          <h1 className="text-xl font-semibold text-foreground">FitKoh Bridge</h1>
          <p className="text-sm text-muted-foreground">Sign in with your email</p>
        </div>

        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          className="w-full px-4 py-3 rounded-xl bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          autoFocus
        />

        {error && (
          <p className="text-sm text-destructive text-center" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !email.includes('@')}
          className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold disabled:opacity-50 transition-opacity flex items-center justify-center gap-2"
        >
          {loading && <Loader2 size={16} className="animate-spin" />}
          {loading ? 'Sending…' : 'Send magic link'}
        </button>
      </form>
    </div>
  )
}

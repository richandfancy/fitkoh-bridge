import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Loader2 } from 'lucide-react'

export function LoginScreen() {
  const { login } = useAuth()
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const ok = await login(secret)
    setLoading(false)
    if (!ok) setError('Invalid access code')
  }

  return (
    <div className="min-h-dvh bg-background flex items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div className="text-center space-y-2">
          <div className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center mx-auto">
            <span className="text-primary-foreground font-bold text-2xl">FB</span>
          </div>
          <h1 className="text-xl font-semibold text-foreground">FitKoh Bridge</h1>
          <p className="text-sm text-muted-foreground">Enter access code to continue</p>
        </div>

        <input
          type="password"
          value={secret}
          onChange={e => setSecret(e.target.value)}
          placeholder="Access code"
          className="w-full px-4 py-3 rounded-xl bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          autoFocus
        />

        {error && <p className="text-sm text-destructive text-center">{error}</p>}

        <button
          type="submit"
          disabled={loading || !secret}
          className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold disabled:opacity-50 transition-opacity flex items-center justify-center gap-2"
        >
          {loading && <Loader2 size={16} className="animate-spin" />}
          {loading ? 'Checking...' : 'Enter'}
        </button>
      </form>
    </div>
  )
}

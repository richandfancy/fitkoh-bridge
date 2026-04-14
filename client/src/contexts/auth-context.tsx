import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { api } from '@/lib/api'

type RequestLinkResult =
  | { ok: true }
  | { ok: false; error: 'rate_limited' | 'invalid_email' | 'send_failed' | 'unknown' }

interface AuthContextValue {
  isAuthenticated: boolean
  isLoading: boolean
  requestMagicLink: (email: string) => Promise<RequestLinkResult>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  // Check session on mount
  useEffect(() => {
    api.get('/api/auth/check')
      .then(() => setIsAuthenticated(true))
      .catch(() => setIsAuthenticated(false))
      .finally(() => setIsLoading(false))
  }, [])

  // Listen for 401 events from api client
  useEffect(() => {
    const handler = () => setIsAuthenticated(false)
    window.addEventListener('auth:logout', handler)
    return () => window.removeEventListener('auth:logout', handler)
  }, [])

  const requestMagicLink = useCallback(async (email: string): Promise<RequestLinkResult> => {
    try {
      const resp = await fetch('/api/auth/request-link', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })

      if (resp.ok) {
        return { ok: true }
      }

      const body = (await resp.json().catch(() => ({}))) as { error?: string }
      const code = body.error
      if (code === 'rate_limited' || code === 'invalid_email' || code === 'send_failed') {
        return { ok: false, error: code }
      }
      return { ok: false, error: 'unknown' }
    } catch {
      return { ok: false, error: 'unknown' }
    }
  }, [])

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => {})
    setIsAuthenticated(false)
  }, [])

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, requestMagicLink, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

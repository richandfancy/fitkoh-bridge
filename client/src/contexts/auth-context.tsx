import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { api } from '@/lib/api'

interface AuthContextValue {
  isAuthenticated: boolean
  isLoading: boolean
  login: (secret: string) => Promise<boolean>
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

  const login = useCallback(async (secret: string): Promise<boolean> => {
    try {
      await api.post('/api/auth/login', { secret })
      setIsAuthenticated(true)
      return true
    } catch {
      return false
    }
  }, [])

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => {})
    setIsAuthenticated(false)
  }, [])

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

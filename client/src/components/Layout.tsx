import { useLocation } from 'wouter'
import { Activity, Users, AlertTriangle, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { api } from '@/lib/api'
import { useState, useEffect, type ReactNode } from 'react'
import type { DashboardStats } from '@shared/types'

const NAV_ITEMS = [
  { path: '/', icon: Activity, label: 'Activity' },
  { path: '/guests', icon: Users, label: 'Guests' },
  { path: '/dead-letters', icon: AlertTriangle, label: 'Errors' },
  { path: '/settings', icon: Settings, label: 'Settings' },
]

export function Layout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation()
  const { logout } = useAuth()
  const [stats, setStats] = useState<DashboardStats | null>(null)

  // Poll stats for dead letter badge count
  useEffect(() => {
    const fetchStats = () => api.get<DashboardStats>('/api/dashboard/stats').then(setStats).catch(() => {})
    fetchStats()
    const interval = setInterval(fetchStats, 10000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="min-h-dvh bg-background pb-20">
      {/* Top header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-lg px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-sm">FB</span>
          </div>
          <span className="font-semibold text-foreground">FitKoh Bridge</span>
        </div>
        <button onClick={logout} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
          Logout
        </button>
      </header>

      {/* Page content */}
      <main className="px-4 py-4 max-w-5xl mx-auto">
        {children}
      </main>

      {/* Floating bottom nav */}
      <nav className="no-print fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 bg-card/90 backdrop-blur-xl border border-border rounded-2xl px-2 py-2 shadow-lg">
        {NAV_ITEMS.map(({ path, icon: Icon, label }) => {
          const isActive = path === '/' ? location === '/' : location.startsWith(path)
          const isDeadLetters = path === '/dead-letters'
          const badgeCount = isDeadLetters ? (stats?.unresolvedDeadLetters || 0) : 0

          return (
            <button
              key={path}
              onClick={() => setLocation(path)}
              className={cn(
                'relative flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-xl transition-all',
                isActive
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon size={20} />
              <span className="text-[10px] font-medium">{label}</span>
              {badgeCount > 0 && (
                <span className="absolute -top-1 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-white px-1">
                  {badgeCount}
                </span>
              )}
            </button>
          )
        })}
      </nav>
    </div>
  )
}

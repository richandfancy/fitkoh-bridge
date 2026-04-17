import { useState, type ReactNode } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { FloatingTabBar } from './FloatingTabBar'
import { CreateGuestDrawer } from './CreateGuestDrawer'

export function Layout({ children }: { children: ReactNode }) {
  const { logout } = useAuth()
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)

  return (
    <div className="min-h-dvh bg-background pb-28">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-lg px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-sm">FB</span>
          </div>
          <span className="font-semibold text-foreground">FitKoh Bridge</span>
        </div>
        <button
          onClick={logout}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Logout
        </button>
      </header>

      <main className="px-4 py-4 max-w-5xl mx-auto">{children}</main>

      <FloatingTabBar onAddGuest={() => setIsDrawerOpen(true)} />

      <CreateGuestDrawer open={isDrawerOpen} onClose={() => setIsDrawerOpen(false)} />
    </div>
  )
}

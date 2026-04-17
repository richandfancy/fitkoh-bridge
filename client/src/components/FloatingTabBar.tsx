import { useLocation } from 'wouter'
import { Plus, ShoppingBag, UserRound, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

type NavItem = {
  path: string
  icon: LucideIcon
  label: string
}

const NAV_ITEMS: NavItem[] = [
  { path: '/orders', icon: ShoppingBag, label: 'Orders' },
  { path: '/', icon: UserRound, label: 'Guests' },
]

// Routes that render UsersPage — Guests tab highlights on any of them.
const GUESTS_PATHS = new Set(['/', '/guests', '/users'])

interface FloatingTabBarProps {
  onAddUser: () => void
  addDisabled?: boolean
}

export function FloatingTabBar({ onAddUser, addDisabled }: FloatingTabBarProps) {
  const [location, setLocation] = useLocation()

  const isActive = (path: string) => {
    if (path === '/') return GUESTS_PATHS.has(location)
    return location === path || location.startsWith(`${path}/`)
  }

  return (
    <nav
      aria-label="Primary"
      className="no-print fixed inset-x-0 z-50 pointer-events-none"
      style={{ bottom: 'max(24px, env(safe-area-inset-bottom, 0px))' }}
    >
      <div className="mx-auto flex w-fit items-center gap-2 pointer-events-auto">
        <div className="flex items-center h-[52px] rounded-[26px] bg-background/90 backdrop-blur-2xl backdrop-saturate-150 border border-border shadow-lg shadow-black/25 px-1">
          {NAV_ITEMS.map(({ path, icon: Icon, label }) => {
            const active = isActive(path)
            return (
              <button
                key={path}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => setLocation(path)}
                className={cn(
                  'flex flex-col items-center justify-center gap-0.5 px-4 h-full transition-colors active:scale-[0.97]',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[10px] font-medium leading-tight">{label}</span>
              </button>
            )
          })}
        </div>

        <button
          type="button"
          onClick={onAddUser}
          disabled={addDisabled}
          aria-label="Create user"
          className="flex items-center justify-center w-[52px] h-[52px] rounded-[26px] bg-background/90 backdrop-blur-2xl backdrop-saturate-150 text-primary border border-border shadow-lg shadow-black/25 active:scale-[0.92] transition-transform disabled:opacity-70"
        >
          <Plus className="w-6 h-6" />
        </button>
      </div>
    </nav>
  )
}

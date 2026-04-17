import { cn } from '@/lib/utils'

const VARIANTS = {
  booking_new: 'bg-status-blue/15 text-status-blue',
  guest_created: 'bg-status-green/15 text-status-green',
  checkout: 'bg-status-amber/15 text-status-amber',
  charge_posted: 'bg-status-green/15 text-status-green',
  cache_warmed: 'bg-status-blue/15 text-status-blue',
  error: 'bg-status-red/15 text-status-red',
  active: 'bg-status-blue/15 text-status-blue',
  checked_out: 'bg-status-amber/15 text-status-amber',
  synced: 'bg-status-green/15 text-status-green',
} as const

export function Badge({ variant, children }: { variant: keyof typeof VARIANTS; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium', VARIANTS[variant] || 'bg-muted text-muted-foreground')}>
      {children}
    </span>
  )
}

import { useState, useEffect, useRef } from 'react'
import { useLocation } from 'wouter'
import { Activity, Loader2, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Badge } from '@/components/Badge'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import type { ActivityLogEntry, ActivityType } from '@shared/types'

const FILTER_OPTIONS: { label: string; value: ActivityType | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Bookings', value: 'booking_new' },
  { label: 'Guests Created', value: 'guest_created' },
  { label: 'Checkouts', value: 'checkout' },
  { label: 'Charges', value: 'charge_posted' },
  { label: 'Errors', value: 'error' },
]

const TYPE_LABELS: Record<ActivityType, string> = {
  booking_new: 'Booking',
  guest_created: 'Guest Created',
  checkout: 'Checkout',
  charge_posted: 'Charge',
  error: 'Error',
}

const DOT_COLORS: Record<ActivityType, string> = {
  booking_new: 'bg-status-blue',
  guest_created: 'bg-status-green',
  checkout: 'bg-status-amber',
  charge_posted: 'bg-status-green',
  error: 'bg-status-red',
}

export function ActivityPage() {
  const [, setLocation] = useLocation()
  const [entries, setEntries] = useState<ActivityLogEntry[]>([])
  const [filter, setFilter] = useState<ActivityType | 'all'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const prevIdsRef = useRef<Set<number>>(new Set())

  const fetchActivity = async () => {
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (filter !== 'all') params.set('type', filter)
      const data = await api.get<ActivityLogEntry[]>(`/api/dashboard/activity?${params}`)
      setEntries(data)
      prevIdsRef.current = new Set(data.map(e => e.id))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load activity')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    fetchActivity()
    const interval = setInterval(fetchActivity, 5000)
    return () => clearInterval(interval)
  }, [filter])

  if (loading) {
    return (
      <div className="space-y-3 animate-fade-in">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold">Activity</h1>
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
            <Skeleton className="w-2.5 h-2.5 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3 animate-fade-in-up pb-24">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Activity</h1>
      </div>

      {/* Filter bar */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {FILTER_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors',
              filter === opt.value
                ? 'bg-primary/15 text-primary'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-card border border-destructive/30 rounded-xl p-4 text-center space-y-2">
          <p className="text-sm text-destructive">{error}</p>
          <button
            onClick={() => { setLoading(true); fetchActivity() }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors"
          >
            <RefreshCw size={14} />
            Retry
          </button>
        </div>
      )}

      {!error && entries.length === 0 && (
        <EmptyState icon={Activity} title="No activity yet" description="Events will appear here as they happen" />
      )}

      {entries.map(entry => (
        <div
          key={entry.id}
          onClick={() => entry.booking_id ? setLocation(`/guests/${entry.booking_id}`) : undefined}
          className={cn(
            'bg-card border border-border rounded-xl p-4 flex items-center gap-3 animate-fade-in-up',
            entry.booking_id && 'hover:bg-secondary/50 cursor-pointer transition-colors'
          )}
        >
          <div className={cn('w-2.5 h-2.5 rounded-full shrink-0', DOT_COLORS[entry.type])} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{entry.summary}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{formatRelativeTime(entry.created_at)}</p>
          </div>
          <Badge variant={entry.type}>{TYPE_LABELS[entry.type]}</Badge>
        </div>
      ))}
    </div>
  )
}

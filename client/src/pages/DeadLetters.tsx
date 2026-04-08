import { useState, useEffect } from 'react'
import { useLocation } from 'wouter'
import { AlertTriangle, CheckCircle, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Badge } from '@/components/Badge'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import type { DeadLetter } from '@shared/types'

const OPERATION_LABELS: Record<string, string> = {
  guest_create: 'Guest Create',
  charge_post: 'Charge Post',
  folio_lookup: 'Folio Lookup',
}

export function DeadLettersPage() {
  const [, setLocation] = useLocation()
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set())

  const fetchDeadLetters = async () => {
    try {
      const data = await api.get<DeadLetter[]>('/api/dashboard/dead-letters')
      setDeadLetters(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load errors')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDeadLetters()
  }, [])

  const handleRetry = async (dl: DeadLetter) => {
    const key = `retry-${dl.id}`
    setPendingActions(prev => new Set(prev).add(key))
    try {
      await api.post(`/api/dashboard/dead-letters/${dl.id}/retry`)
      toast.success('Retry queued successfully')
      await fetchDeadLetters()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setPendingActions(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleResolve = async (dl: DeadLetter) => {
    const key = `resolve-${dl.id}`
    setPendingActions(prev => new Set(prev).add(key))
    try {
      await api.post(`/api/dashboard/dead-letters/${dl.id}/resolve`)
      toast.success('Marked as resolved')
      await fetchDeadLetters()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Resolve failed')
    } finally {
      setPendingActions(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  if (loading) {
    return (
      <div className="space-y-3 animate-fade-in">
        <h1 className="text-xl font-semibold mb-4">Errors</h1>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-16" />
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="animate-fade-in">
        <h1 className="text-xl font-semibold mb-4">Errors</h1>
        <div className="bg-card border border-destructive/30 rounded-xl p-6 text-center space-y-2">
          <p className="text-sm text-destructive">{error}</p>
          <button
            onClick={() => { setLoading(true); fetchDeadLetters() }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors"
          >
            <RefreshCw size={14} />
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3 animate-fade-in-up pb-24">
      <h1 className="text-xl font-semibold mb-1">Errors</h1>

      {deadLetters.length === 0 ? (
        <EmptyState icon={CheckCircle} title="All clear — no errors" description="Everything is running smoothly" />
      ) : (
        deadLetters.map(dl => (
          <div key={dl.id} className="bg-card border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="error">{OPERATION_LABELS[dl.operation] || dl.operation}</Badge>
              {dl.retries > 0 && (
                <span className="text-xs text-muted-foreground">Retries: {dl.retries}</span>
              )}
              <span className="text-xs text-muted-foreground ml-auto">{formatRelativeTime(dl.created_at)}</span>
            </div>

            <p className="text-sm text-foreground break-words">{dl.error_message || 'No error message'}</p>

            {dl.clock_booking_id && (
              <button
                onClick={() => setLocation(`/guests/${dl.clock_booking_id}`)}
                className="text-xs text-primary hover:underline"
              >
                Booking: {dl.clock_booking_id}
              </button>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => handleRetry(dl)}
                disabled={pendingActions.has(`retry-${dl.id}`)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50 transition-opacity"
              >
                {pendingActions.has(`retry-${dl.id}`) ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                Retry
              </button>
              <button
                onClick={() => handleResolve(dl)}
                disabled={pendingActions.has(`resolve-${dl.id}`)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-secondary-foreground text-xs font-semibold disabled:opacity-50 transition-opacity"
              >
                {pendingActions.has(`resolve-${dl.id}`) ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                Resolve
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

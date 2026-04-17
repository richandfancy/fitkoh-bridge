import { useState, useEffect, useRef } from 'react'
import { ShoppingBag, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { cn, formatCurrency } from '@/lib/utils'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'

interface LiveItem {
  id: string
  time: string
  productId: number
  productName: string
  quantity: number
  price: number
  table: number
  location: string
  clientName: string | null
  transactionId: number
}

interface FeedResponse {
  date: string
  totalItems: number
  openOrders: number
  closedOrders: number
  items: LiveItem[]
}

function formatTime(dateStr: string): string {
  if (!dateStr) return '—'
  // Poster date format: "2026-04-10 12:00:20"
  const parts = dateStr.split(' ')
  if (parts.length !== 2) return dateStr
  return parts[1].substring(0, 5) // HH:MM
}

function formatRelative(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr.replace(' ', 'T') + '+07:00')
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  return formatTime(dateStr)
}

export function OrdersPage() {
  const [data, setData] = useState<FeedResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [locationFilter, setLocationFilter] = useState<string>('all')
  const seenIds = useRef<Set<string>>(new Set())
  const [newIds, setNewIds] = useState<Set<string>>(new Set())
  const dataRef = useRef<FeedResponse | null>(null)
  const highlightTimers = useRef<Set<number>>(new Set())

  // Keep a ref in sync with the latest data so SSE handlers (which close over
  // the first render) can always read the current feed.
  useEffect(() => {
    dataRef.current = data
  }, [data])

  const highlightNewId = (id: string) => {
    setNewIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
    const timer = window.setTimeout(() => {
      setNewIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      highlightTimers.current.delete(timer)
    }, 3000)
    highlightTimers.current.add(timer)
  }

  const fetchFeed = async () => {
    try {
      const result = await api.get<FeedResponse>('/api/dashboard/orders')

      // Detect new items since last fetch
      const currentNewIds = new Set<string>()
      if (seenIds.current.size > 0) {
        for (const item of result.items) {
          if (!seenIds.current.has(item.id)) {
            currentNewIds.add(item.id)
          }
        }
      }

      // Update seen set
      seenIds.current = new Set(result.items.map((i) => i.id))

      setData(result)
      setNewIds(currentNewIds)
      setError(null)

      // Clear new highlight after 3 seconds
      if (currentNewIds.size > 0) {
        setTimeout(() => setNewIds(new Set()), 3000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load items')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    let eventSource: EventSource | null = null
    let fallbackInterval: number | null = null

    const openStream = () => {
      if (cancelled) return
      // Same-origin EventSource automatically sends the bridge_session cookie.
      eventSource = new EventSource('/api/v1/stream/orders')

      eventSource.addEventListener('snapshot', (ev: MessageEvent) => {
        try {
          const payload = JSON.parse(ev.data) as { items: LiveItem[] }
          // Stream sorts oldest → newest; the dashboard renders newest first.
          const itemsDesc = [...payload.items].sort((a, b) =>
            b.time.localeCompare(a.time),
          )
          seenIds.current = new Set(itemsDesc.map((i) => i.id))
          const prev = dataRef.current
          setData({
            date: prev?.date || new Date().toISOString().split('T')[0],
            totalItems: itemsDesc.length,
            openOrders: prev?.openOrders ?? 0,
            closedOrders: prev?.closedOrders ?? 0,
            items: itemsDesc,
          })
        } catch {
          /* malformed snapshot — ignore */
        }
      })

      eventSource.addEventListener('order_item', (ev: MessageEvent) => {
        try {
          const item = JSON.parse(ev.data) as LiveItem
          if (seenIds.current.has(item.id)) return
          seenIds.current.add(item.id)

          setData((prev) => {
            if (!prev) {
              return {
                date: new Date().toISOString().split('T')[0],
                totalItems: 1,
                openOrders: 0,
                closedOrders: 0,
                items: [item],
              }
            }
            return {
              ...prev,
              items: [item, ...prev.items],
              totalItems: prev.totalItems + 1,
            }
          })
          highlightNewId(item.id)
        } catch {
          /* malformed delta — ignore */
        }
      })

      eventSource.onerror = () => {
        // Close and fall back to polling. EventSource auto-reconnects on
        // transient network errors, but after 5 min the worker closes the
        // stream cleanly and we want to reopen rather than spin.
        if (eventSource) {
          eventSource.close()
          eventSource = null
        }
        if (cancelled) return
        // Start fallback polling if not already running
        if (fallbackInterval === null) {
          fallbackInterval = window.setInterval(fetchFeed, 5000)
        }
        // Try to reopen the stream after 5s
        window.setTimeout(() => {
          if (!cancelled) {
            if (fallbackInterval !== null) {
              window.clearInterval(fallbackInterval)
              fallbackInterval = null
            }
            openStream()
          }
        }, 5000)
      }
    }

    // Initial HTTP load, then open the SSE stream
    fetchFeed().then(() => {
      if (!cancelled) openStream()
    })

    return () => {
      cancelled = true
      if (eventSource) eventSource.close()
      if (fallbackInterval !== null) window.clearInterval(fallbackInterval)
      for (const timer of highlightTimers.current) window.clearTimeout(timer)
      highlightTimers.current.clear()
    }
  }, [])

  // Extract unique locations
  const locations = data
    ? Array.from(new Set(data.items.map((i) => i.location))).sort()
    : []

  const filtered = data
    ? locationFilter === 'all'
      ? data.items
      : data.items.filter((i) => i.location === locationFilter)
    : []

  // Total revenue for the filtered items
  const totalRevenue = filtered.reduce(
    (sum, i) => sum + i.price * i.quantity,
    0,
  )

  // Group items by transaction for compact display
  const grouped: Array<{
    time: string
    transactionId: number
    table: number
    location: string
    clientName: string | null
    items: LiveItem[]
    isNew: boolean
  }> = []

  if (filtered.length > 0) {
    let currentGroup: (typeof grouped)[0] | null = null
    for (const item of filtered) {
      if (!currentGroup || currentGroup.transactionId !== item.transactionId) {
        if (currentGroup) grouped.push(currentGroup)
        currentGroup = {
          time: item.time,
          transactionId: item.transactionId,
          table: item.table,
          location: item.location,
          clientName: item.clientName,
          items: [item],
          isNew: newIds.has(item.id),
        }
      } else {
        currentGroup.items.push(item)
        if (newIds.has(item.id)) currentGroup.isNew = true
      }
    }
    if (currentGroup) grouped.push(currentGroup)
  }

  if (loading) {
    return (
      <div className="space-y-2 animate-fade-in">
        <h1 className="text-xl font-semibold mb-4">Live Feed</h1>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="bg-card border border-border rounded-xl p-3 flex items-center gap-3"
          >
            <Skeleton className="w-10 h-10 rounded-lg shrink-0" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2 animate-fade-in-up pb-24">
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Live Feed</h1>
        {data && (
          <div className="flex items-center gap-1.5 text-xs">
            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            <span className="text-muted-foreground">Live</span>
          </div>
        )}
      </div>

      {/* Revenue + stats card */}
      {data && (
        <div className="bg-card border border-border rounded-xl p-4 mb-1">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                Revenue today
              </div>
              <div className="text-3xl font-bold text-foreground tabular-nums">
                {formatCurrency(totalRevenue)}
              </div>
            </div>
            <div className="flex items-center gap-4 text-xs shrink-0 pb-1">
              <div className="text-right">
                <div className="text-muted-foreground">Items</div>
                <div className="font-semibold text-foreground tabular-nums">
                  {filtered.length}
                </div>
              </div>
              <div className="text-right">
                <div className="text-muted-foreground">Open</div>
                <div className="font-semibold text-status-amber tabular-nums">
                  {data.openOrders}
                </div>
              </div>
              <div className="text-right">
                <div className="text-muted-foreground">Closed</div>
                <div className="font-semibold text-status-green tabular-nums">
                  {data.closedOrders}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Location filter */}
      {locations.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          <button
            onClick={() => setLocationFilter('all')}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors',
              locationFilter === 'all'
                ? 'bg-primary/15 text-primary'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
            )}
          >
            All ({data?.totalItems || 0})
          </button>
          {locations.map((loc) => {
            const count = data?.items.filter((i) => i.location === loc).length || 0
            return (
              <button
                key={loc}
                onClick={() => setLocationFilter(loc)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors',
                  locationFilter === loc
                    ? 'bg-primary/15 text-primary'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
                )}
              >
                {loc} ({count})
              </button>
            )
          })}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="bg-card border border-destructive/30 rounded-xl p-4 text-center space-y-2">
          <p className="text-sm text-destructive">{error}</p>
          <button
            onClick={() => {
              setLoading(true)
              fetchFeed()
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors"
          >
            <RefreshCw size={14} />
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {!error && filtered.length === 0 && (
        <EmptyState
          icon={ShoppingBag}
          title="No items yet"
          description="Items from Poster will appear here as orders close"
        />
      )}

      {/* Item feed grouped by transaction */}
      {grouped.map((group) => {
        const groupTotal = group.items.reduce(
          (sum, i) => sum + i.price * i.quantity,
          0,
        )
        return (
          <div
            key={group.transactionId}
            className={cn(
              'bg-card border rounded-xl overflow-hidden transition-all',
              group.isNew
                ? 'border-primary/50 shadow-[0_0_20px_rgba(150,220,100,0.15)] animate-fade-in-up'
                : 'border-border',
            )}
          >
            {/* Transaction header — two rows so guest name + location
                aren't truncated on mobile. */}
            <div className="px-4 py-2 border-b border-border/50 bg-background/30">
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-muted-foreground shrink-0">
                    {formatTime(group.time)}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span className="font-medium text-foreground shrink-0">
                    Table {group.table}
                  </span>
                </div>
                <span className="text-muted-foreground tabular-nums shrink-0">
                  {formatRelative(group.time)}
                </span>
              </div>
              {(group.location || group.clientName) && (
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                  <span className="truncate">{group.location}</span>
                  {group.clientName && (
                    <>
                      <span className="shrink-0">·</span>
                      <span className="truncate">{group.clientName}</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Items */}
            <div className="divide-y divide-border/30">
              {group.items.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    'px-4 py-2.5 flex items-center justify-between gap-3',
                    newIds.has(item.id) && 'bg-primary/5',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-foreground">
                      {item.quantity > 1 && (
                        <span className="text-muted-foreground mr-1">
                          {item.quantity}×
                        </span>
                      )}
                      {item.productName}
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
                    {formatCurrency(item.price)}
                  </span>
                </div>
              ))}
            </div>

            {/* Transaction total */}
            <div className="px-4 py-2 flex items-center justify-between bg-background/20 border-t border-border/30">
              <span className="text-xs text-muted-foreground">
                {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
              </span>
              <span className="text-xs font-semibold text-foreground tabular-nums">
                {formatCurrency(groupTotal)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

import { useState, useEffect } from 'react'
import { ShoppingBag, Loader2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'
import { api } from '@/lib/api'
import { cn, formatCurrency } from '@/lib/utils'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'

interface Order {
  transactionId: string
  status: 'open' | 'closed'
  table: string
  location: string
  clientId: number | null
  clientName: string | null
  total: number
  openedAt: string | null
  closedAt: string | null
}

interface OrdersResponse {
  date: string
  total: number
  open: number
  closed: number
  orders: Order[]
}

interface OrderItem {
  productId: string
  name: string
  quantity: number
  unitPrice: number
}

interface OrderDetail {
  transactionId: string
  status: 'open' | 'closed'
  table: string
  location: string
  clientName: string | null
  total: number
  items: OrderItem[]
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  })
}

function OrderRow({ order }: { order: Order }) {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<OrderDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const toggle = async () => {
    if (!expanded && !detail) {
      setLoadingDetail(true)
      try {
        const d = await api.get<OrderDetail>(`/api/dashboard/orders/${order.transactionId}`)
        setDetail(d)
      } catch {
        // silently fail
      } finally {
        setLoadingDetail(false)
      }
    }
    setExpanded(!expanded)
  }

  const isOpen = order.status === 'open'

  return (
    <div
      className={cn(
        'bg-card border rounded-xl overflow-hidden animate-fade-in',
        isOpen ? 'border-status-amber/30' : 'border-border',
      )}
    >
      <button
        onClick={toggle}
        className="w-full p-4 flex items-center gap-3 hover:bg-secondary/30 transition-colors text-left"
      >
        {/* Status indicator */}
        <div className="flex flex-col items-center shrink-0">
          <div
            className={cn(
              'w-2.5 h-2.5 rounded-full',
              isOpen ? 'bg-status-amber animate-pulse' : 'bg-status-green',
            )}
          />
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">
              Table {order.table}
            </span>
            <span className="text-xs text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground truncate">
              {order.location}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">
            {order.clientName || 'Walk-in'}
            {order.openedAt && <> · opened {formatTime(order.openedAt)}</>}
            {order.closedAt && <> · closed {formatTime(order.closedAt)}</>}
          </div>
        </div>

        {/* Total + chevron */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right">
            <div className="text-sm font-semibold text-foreground">
              {formatCurrency(order.total)}
            </div>
            <div
              className={cn(
                'text-[10px] font-medium uppercase tracking-wide',
                isOpen ? 'text-status-amber' : 'text-status-green',
              )}
            >
              {isOpen ? 'Open' : 'Closed'}
            </div>
          </div>
          {expanded ? (
            <ChevronUp size={16} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={16} className="text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border px-4 py-3 bg-background/40">
          {loadingDetail ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          ) : detail && detail.items.length > 0 ? (
            <div className="space-y-1">
              {detail.items.map((item, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between text-xs py-1"
                >
                  <span className="text-foreground">
                    {item.quantity > 1 && (
                      <span className="text-muted-foreground">
                        {item.quantity}× {' '}
                      </span>
                    )}
                    {item.name}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatCurrency(item.unitPrice * item.quantity)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-2">
              No line items
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function OrdersPage() {
  const [data, setData] = useState<OrdersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [locationFilter, setLocationFilter] = useState<string>('all')

  const fetchOrders = async () => {
    try {
      const result = await api.get<OrdersResponse>('/api/dashboard/orders')
      setData(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchOrders()
    const interval = setInterval(fetchOrders, 5000)
    return () => clearInterval(interval)
  }, [])

  // Extract unique locations for filter
  const locations = data
    ? Array.from(new Set(data.orders.map((o) => o.location))).sort()
    : []

  const filtered = data
    ? locationFilter === 'all'
      ? data.orders
      : data.orders.filter((o) => o.location === locationFilter)
    : []

  if (loading) {
    return (
      <div className="space-y-3 animate-fade-in">
        <h1 className="text-xl font-semibold mb-4">Live Orders</h1>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-4">
            <Skeleton className="h-4 w-3/4 mb-2" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3 animate-fade-in-up pb-24">
      {/* Header with stats */}
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Live Orders</h1>
        {data && (
          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-status-amber animate-pulse" />
              <span className="text-muted-foreground">
                {data.open} open
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-status-green" />
              <span className="text-muted-foreground">
                {data.closed} closed
              </span>
            </div>
          </div>
        )}
      </div>

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
            All ({data?.total || 0})
          </button>
          {locations.map((loc) => {
            const count = data?.orders.filter((o) => o.location === loc).length || 0
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
              fetchOrders()
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
          title="No orders yet"
          description="Orders will appear here as they come in from Poster"
        />
      )}

      {/* Order rows */}
      {filtered.map((order) => (
        <OrderRow key={order.transactionId} order={order} />
      ))}
    </div>
  )
}

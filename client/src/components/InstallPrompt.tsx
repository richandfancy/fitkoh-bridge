import { useEffect, useState } from 'react'
import { Download, X, RefreshCw } from 'lucide-react'
import { applyPendingUpdate } from '@/lib/registerSW'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'bridge:install-dismissed-at'
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

function wasRecentlyDismissed(): boolean {
  const raw = localStorage.getItem(DISMISS_KEY)
  if (!raw) return false
  const ts = Number(raw)
  if (!Number.isFinite(ts)) return false
  return Date.now() - ts < DISMISS_TTL_MS
}

export function InstallPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [updateRegistration, setUpdateRegistration] = useState<ServiceWorkerRegistration | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (isStandalone() || wasRecentlyDismissed()) return

    const onInstallPrompt = (e: Event) => {
      e.preventDefault()
      setInstallEvent(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onInstallPrompt)
  }, [])

  useEffect(() => {
    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent<{ registration: ServiceWorkerRegistration }>).detail
      setUpdateRegistration(detail.registration)
    }
    window.addEventListener('bridge:sw:update-available', onUpdate)
    return () => window.removeEventListener('bridge:sw:update-available', onUpdate)
  }, [])

  if (dismissed) return null

  // Update banner takes priority over install banner.
  if (updateRegistration) {
    return (
      <Banner
        icon={<RefreshCw className="w-4 h-4" />}
        label="A new version is ready"
        actionLabel="Reload"
        onAction={() => applyPendingUpdate(updateRegistration)}
        onDismiss={() => setUpdateRegistration(null)}
      />
    )
  }

  if (installEvent) {
    return (
      <Banner
        icon={<Download className="w-4 h-4" />}
        label="Install FitKoh Bridge"
        actionLabel="Install"
        onAction={async () => {
          await installEvent.prompt()
          const { outcome } = await installEvent.userChoice
          if (outcome === 'dismissed') {
            localStorage.setItem(DISMISS_KEY, String(Date.now()))
          }
          setInstallEvent(null)
        }}
        onDismiss={() => {
          localStorage.setItem(DISMISS_KEY, String(Date.now()))
          setDismissed(true)
        }}
      />
    )
  }

  return null
}

interface BannerProps {
  icon: React.ReactNode
  label: string
  actionLabel: string
  onAction: () => void
  onDismiss: () => void
}

function Banner({ icon, label, actionLabel, onAction, onDismiss }: BannerProps) {
  return (
    <div
      className="no-print fixed inset-x-0 z-40 px-4 pt-safe"
      style={{ top: 'max(12px, env(safe-area-inset-top, 0px))' }}
    >
      <div className="mx-auto max-w-md flex items-center gap-3 rounded-2xl bg-card/95 backdrop-blur-xl border border-border shadow-lg px-3 py-2">
        <span className="text-primary">{icon}</span>
        <span className="flex-1 text-sm text-foreground">{label}</span>
        <button
          type="button"
          onClick={onAction}
          className="px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-semibold active:scale-[0.97] transition-transform"
        >
          {actionLabel}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="p-1.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

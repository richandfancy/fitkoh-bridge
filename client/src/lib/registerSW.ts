// Service worker registration for FitKoh Bridge.
// Registers /sw.js and dispatches a window event when a new version is waiting
// so the UI can prompt the user to reload. No auto-reload — admin users may be
// mid-write.
//
// Reload guard (BAC-1219 / I9): `controllerchange` also fires when another tab
// claims an updated worker, when the user clears site data, or on cold install.
// Reloading unconditionally would interrupt admins mid-write. We only reload
// when this tab explicitly asked the waiting worker to skip waiting.

let skipWaitingRequested = false
let refreshing = false

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  if (import.meta.env.DEV) return

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            if (
              installing.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              window.dispatchEvent(
                new CustomEvent('bridge:sw:update-available', {
                  detail: { registration },
                }),
              )
            }
          })
        })
      })
      .catch((err) => {
        console.warn('[sw] registration failed', err)
      })

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!skipWaitingRequested) return
      if (refreshing) return
      refreshing = true
      window.location.reload()
    })
  })
}

export function applyPendingUpdate(registration: ServiceWorkerRegistration): void {
  skipWaitingRequested = true
  registration.waiting?.postMessage({ type: 'SKIP_WAITING' })
}

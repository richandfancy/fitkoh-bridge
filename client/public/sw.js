// FitKoh Bridge Service Worker
// CACHE_VERSION is rewritten at build time by swVersionPlugin in vite.config.ts.
// Bump manually in dev if you change caching behavior without rebuilding.

const CACHE_VERSION = 'bridge-dev'
const ASSET_CACHE = `bridge-assets-${CACHE_VERSION}`
const RUNTIME_CACHE = `bridge-runtime-${CACHE_VERSION}`

// On install: activate immediately so the next page load uses this SW.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

// On activate: drop old caches from previous deploys and claim all clients.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k.startsWith('bridge-') && !k.endsWith(CACHE_VERSION))
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

// Listen for skipWaiting signal from the page ("reload to update" button).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Only handle same-origin requests.
  if (url.origin !== self.location.origin) return

  // Never cache service-worker-related endpoints or auth callbacks.
  if (
    url.pathname === '/sw.js' ||
    url.pathname === '/manifest.json' ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/api/auth/')
  ) {
    return
  }

  // SSE streams must bypass the SW entirely.
  if (url.pathname.startsWith('/api/v1/stream/')) return

  // Network-first for API — admin dashboards want live data; cache only as
  // offline fallback.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request))
    return
  }

  // Stale-while-revalidate for hashed build assets (content-addressed, safe
  // to serve from cache indefinitely).
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icon')) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE))
    return
  }

  // Navigation requests: network-first with SPA fallback to cached /.
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request))
    return
  }
})

async function networkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(request)
    if (cached) return cached
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone())
      return response
    })
    .catch(() => cached)
  return cached || networkPromise
}

async function navigationHandler(request) {
  try {
    const response = await fetch(request)
    const cache = await caches.open(RUNTIME_CACHE)
    cache.put('/', response.clone())
    return response
  } catch {
    const cached = await caches.match('/')
    if (cached) return cached
    return new Response('Offline', { status: 503 })
  }
}

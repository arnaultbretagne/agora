// The client's service worker (docs/specs/notifications.md, "The client"): it shows the declarative Web Push message
// Agora sends where the browser does not show it by itself, sets the badge, and opens the Workstream a notification is
// for. It caches nothing: the client is always the server's.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

/** The message's notification, when it is one of Agora's: `web_push` 8030 and a title. */
function notificationOf(data) {
  let message = null
  try {
    message = data ? data.json() : null
  } catch {
    message = null
  }
  const n = message && message.web_push === 8030 ? message.notification : null
  return n && typeof n.title === 'string' && n.title !== '' && typeof n.navigate === 'string' ? n : null
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const n = notificationOf(event.data)
      // Every push shows something: a browser revokes a subscription whose pushes show nothing.
      if (n === null) return self.registration.showNotification('Agora')
      const badge = Number(n.app_badge)
      if (Number.isInteger(badge) && 'setAppBadge' in self.navigator)
        await (badge > 0 ? self.navigator.setAppBadge(badge) : self.navigator.clearAppBadge()).catch(() => undefined)
      await self.registration.showNotification(n.title, {
        body: typeof n.body === 'string' ? n.body : '',
        tag: typeof n.tag === 'string' ? n.tag : undefined,
        icon: '/icon-192.png',
        data: { ...(n.data && typeof n.data === 'object' ? n.data : {}), navigate: n.navigate },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  // Only the client's own addresses: a notification opens one of its Workstreams, or the client.
  const url = new URL(typeof data.navigate === 'string' ? data.navigate : '/', self.location.origin)
  const target = url.origin === self.location.origin ? url.href : self.location.origin + '/'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) {
        await open.focus()
        open.postMessage({ type: 'agora.open', workstream: typeof data.workstream === 'string' ? data.workstream : null })
        return
      }
      await self.clients.openWindow(target)
    })(),
  )
})

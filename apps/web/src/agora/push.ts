// Notifications in the browser (docs/specs/notifications.md, "The client"): the service worker registered, the switch of
// the account's menu — the permission, the Push API's subscription, the server's copy of it —, and, each time the client
// is shown, the notifications whose card is no longer pending closed and the badge set to what is.
import { useCallback, useEffect, useState } from 'react'
import type { Api } from './api.ts'

/** What the switch shows. `hidden`: the server sends none, or the browser has no Push API and is not an iPhone's. */
export type PushStatus = 'hidden' | 'install' | 'blocked' | 'off' | 'on' | 'busy'

/** An iPhone or an iPad outside the Home Screen: Safari offers the Push API only to a web app added to it. */
function outsideHomeScreen(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  return ios && !standalone
}

const supported = (): boolean => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined'

/** The key's bytes, as `applicationServerKey` takes them. */
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const text = atob(key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '='))
  const out = new Uint8Array(new ArrayBuffer(text.length))
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

function sameKey(subscription: PushSubscription, key: string): boolean {
  const held = subscription.options.applicationServerKey
  if (held === null) return false
  const a = new Uint8Array(held),
    b = keyBytes(key)
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * The person's opt-out, kept by the browser: once notifications are turned off, nothing turns them on again but the
 * switch — not a subscription the browser failed to drop (docs/specs/notifications.md, "The client", "Off").
 */
const OFF_KEY = 'agora:notifications-off'
function optedOut(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) === 'true'
  } catch {
    return false
  }
}
function optOut(off: boolean): void {
  try {
    if (off) localStorage.setItem(OFF_KEY, 'true')
    else localStorage.removeItem(OFF_KEY)
  } catch {
    // Without storage, the server's copy alone says it: removed, nothing is sent.
  }
}

/** The service worker, registered once the page opens; null where there is none. */
export function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(null)
  return navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null)
}

/**
 * Each time the client is shown (docs/specs/notifications.md, "The client", "Opened"): the notifications shown whose
 * card is no longer pending, closed; the badge, the number of cards that are.
 */
export async function tidy(api: Api): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  const cards = await api.pendingCards().catch(() => null)
  if (cards === null) return
  const registration = await navigator.serviceWorker.getRegistration('/').catch(() => undefined)
  const pending = new Set(cards.map((c) => `${c.workstream}:${c.position}`))
  for (const n of (await registration?.getNotifications().catch(() => [])) ?? []) {
    const data = (n.data ?? {}) as { workstream?: unknown; position?: unknown }
    if (!pending.has(`${String(data.workstream)}:${String(data.position)}`)) n.close()
  }
  if ('setAppBadge' in navigator) await (cards.length > 0 ? navigator.setAppBadge(cards.length) : navigator.clearAppBadge()).catch(() => undefined)
}

/** The switch (docs/specs/notifications.md, "The client"): what it shows, and turning notifications on or off. */
export function usePush(api: Api): { status: PushStatus; toggle: () => void } {
  const [key, setKey] = useState<string | null>(null)
  const [status, setStatus] = useState<PushStatus>('hidden')

  // What the browser holds now: the permission, its subscription; one made with another key, or the server's copy lost, is made again.
  const settle = useCallback(
    async (key: string) => {
      if (!supported()) return setStatus(outsideHomeScreen() ? 'install' : 'hidden')
      if (Notification.permission === 'denied') return setStatus('blocked')
      const registration = await registerWorker()
      if (registration === null) return setStatus('hidden')
      let subscription = await registration.pushManager.getSubscription().catch(() => null)
      if (optedOut()) {
        // Turned off: a subscription the browser kept is dropped again, never posted.
        await subscription?.unsubscribe().catch(() => false)
        return setStatus('off')
      }
      if (Notification.permission !== 'granted' || subscription === null) {
        // A subscription without the permission shows nothing: gone with it.
        await subscription?.unsubscribe().catch(() => false)
        return setStatus('off')
      }
      if (!sameKey(subscription, key)) {
        // Made with a key the server no longer signs with: its pushes would be refused. Replaced, here and there.
        await api.unsubscribe(subscription.endpoint).catch(() => false)
        await subscription.unsubscribe().catch(() => false)
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }).catch(() => null)
        if (subscription === null) return setStatus('off')
      }
      setStatus((await api.subscribe(subscription.toJSON() as Record<string, unknown>).catch(() => false)) ? 'on' : 'off')
    },
    [api],
  )

  useEffect(() => {
    let live = true
    void api.pushKey().then(
      (k) => {
        if (!live || k === null) return
        setKey(k)
        void settle(k)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [api, settle])

  const toggle = useCallback(() => {
    if (key === null || (status !== 'on' && status !== 'off')) return
    const was = status
    // Asked at once, in the tap itself: Safari asks only from a gesture, before anything is awaited.
    const asked = was === 'off' ? Notification.requestPermission().catch(() => 'denied' as NotificationPermission) : null
    setStatus('busy')
    void (async () => {
      const registration = await registerWorker()
      if (registration === null) return setStatus('hidden')
      if (was === 'on') {
        const subscription = await registration.pushManager.getSubscription().catch(() => null)
        if (subscription !== null) {
          // The server's copy first: while it stands, pushes come, and the switch says on.
          if (!(await api.unsubscribe(subscription.endpoint).catch(() => false))) return setStatus('on')
          await subscription.unsubscribe().catch(() => false)
        }
        optOut(true)
        return setStatus('off')
      }
      const permission = await asked!
      if (permission !== 'granted') return setStatus(permission === 'denied' ? 'blocked' : 'off')
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }).catch(() => null)
      if (subscription === null) return setStatus('off')
      const stored = await api.subscribe(subscription.toJSON() as Record<string, unknown>).catch(() => false)
      if (stored) optOut(false)
      setStatus(stored ? 'on' : 'off')
    })()
  }, [api, key, status])

  return { status, toggle }
}

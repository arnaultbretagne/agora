// The part of `web-push` 4.0.0 Agora uses (docs/specs/notifications.md): the package ships no types.
declare module 'web-push' {
  export interface PushSubscription {
    endpoint: string
    keys: { p256dh: string; auth: string }
  }
  export interface RequestOptions {
    TTL?: number
    urgency?: 'very-low' | 'low' | 'normal' | 'high'
    topic?: string
    contentEncoding?: 'aes128gcm' | 'aesgcm'
    vapidDetails?: { subject: string; publicKey: string; privateKey: string }
  }
  export interface RequestDetails {
    method: 'POST'
    headers: Record<string, string | number>
    body: Buffer | null
    endpoint: string
  }
  export function generateRequestDetails(subscription: PushSubscription, payload?: string | Buffer | null, options?: RequestOptions): RequestDetails
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string }
}

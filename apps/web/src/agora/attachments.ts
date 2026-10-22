// Attachments (docs/specs/assistant-ui.md, "Attachments"): what the agent accepts, each file prepared in
// the browser as the ACP block it becomes, and a prompt's blocks shown back as a message's attachments.
// Pure but `prepare`, which reads the file and draws an image to re-encode it.
import type { AttachmentAdapter, CompleteAttachment, PendingAttachment, ThreadMessageLike } from '@assistant-ui/react'
import type { Json } from './objects.ts'

/** What the agent accepts in a prompt beyond text and links (docs/specs/log.md, "The Workstream view"). */
export interface PromptCapabilities {
  readonly image: boolean
  readonly audio: boolean
  readonly embeddedContext: boolean
}

/** The longer side an image is sent with at most, and the size under which one already fitting is sent as it is. */
export const IMAGE_SIDE = 2048
export const IMAGE_AS_IS = 1024 * 1024
export const TEXT_MAX = 256 * 1024
export const TOTAL_MAX = 12 * 1024 * 1024
const AS_IS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const QUALITY = 0.85

export type Block =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string; readonly uri: string }
  | { readonly type: 'resource'; readonly resource: { readonly uri: string; readonly mimeType: string; readonly text: string } }

type Attachment = NonNullable<ThreadMessageLike['attachments']>[number]

const json = (value: unknown): Json | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function promptCapabilitiesOf(value: unknown): PromptCapabilities | null {
  const v = json(value)
  return v ? { image: v.image === true, audio: v.audio === true, embeddedContext: v.embeddedContext === true } : null
}

/** What the paperclip offers: the file picker's `accept`, or nothing when the agent takes neither. */
export function acceptOf(caps: PromptCapabilities | null): string | null {
  if (caps?.embeddedContext) return '*'
  if (caps?.image) return 'image/*'
  return null
}

/** Why a file is not attached, or null for what it becomes: decided on its type alone, before it is read. */
export function refusalOf(file: { readonly type: string }, caps: PromptCapabilities): string | null {
  const image = file.type.startsWith('image/')
  if (image && !caps.image) return 'the agent does not take images'
  if (!image && !caps.embeddedContext) return 'the agent takes images only'
  return null
}

/** A text file's content: UTF-8 without a NUL character, or why it is not one. */
export function textOf(bytes: Uint8Array): { text: string } | { refused: string } {
  if (bytes.length > TEXT_MAX) return { refused: 'text files are limited to 256 KiB' }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { refused: 'only images and text files can be attached' }
  }
  if (decoded.includes('\0')) return { refused: 'only images and text files can be attached' }
  return { text: decoded }
}

export function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const bytesOf = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

/** The block an attachment's content becomes: its image, or its file as an embedded resource. */
export function blockOf(attachment: Pick<CompleteAttachment, 'name' | 'content'>): Block | null {
  for (const part of attachment.content) {
    if (part.type === 'image') {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image)
      // Its name as its `uri`: no harness fetches one that is not an address, and the thread shows it.
      if (match) return { type: 'image', mimeType: match[1]!, data: match[2]!, uri: attachment.name }
    }
    if (part.type === 'file')
      return { type: 'resource', resource: { uri: attachment.name, mimeType: part.mimeType, text: new TextDecoder().decode(bytesOf(part.data)) } }
  }
  return null
}

/** Write's prompt: the text block when there is text, then the attachments in the order they were added. */
export function promptOf(textValue: string, attachments: readonly Pick<CompleteAttachment, 'name' | 'content'>[]): Block[] {
  const blocks: Block[] = textValue === '' ? [] : [{ type: 'text', text: textValue }]
  for (const a of attachments) {
    const block = blockOf(a)
    if (block) blocks.push(block)
  }
  return blocks
}

const shown = new WeakMap<object, Attachment[]>()

/** A prompt's blocks other than text, as a user message's attachments: kept per element, as images are large. */
export function attachmentsOf(blocks: readonly unknown[], key?: object): Attachment[] {
  const kept = key && shown.get(key)
  if (kept) return kept
  const out = blocks.flatMap((value, i): Attachment[] => {
    const b = json(value)
    if (!b || b.type === 'text') return []
    const base = { id: `block-${String(i)}`, status: { type: 'complete' as const } }
    if (b.type === 'image' && text(b.data) !== '')
      return [{ ...base, type: 'image', name: text(b.uri) || 'image', contentType: text(b.mimeType), content: [{ type: 'image', image: `data:${text(b.mimeType)};base64,${text(b.data)}` }] }]
    const resource = json(b.resource)
    if (b.type === 'resource') return [{ ...base, type: 'document', name: text(resource?.uri) || 'resource', contentType: text(resource?.mimeType), content: [] }]
    if (b.type === 'resource_link') return [{ ...base, type: 'document', name: text(b.uri) || text(b.name) || 'link', content: [] }]
    return [{ ...base, type: 'file', name: text(b.type) || 'content', content: [] }]
  })
  if (key) shown.set(key, out)
  return out
}

/** A file prepared: the content its attachment carries, and the bytes it adds to the prompt. */
export async function prepare(file: File, caps: PromptCapabilities): Promise<{ content: CompleteAttachment['content']; type: 'image' | 'document'; size: number } | { refused: string }> {
  const refused = refusalOf(file, caps)
  if (refused) return { refused }
  if (!file.type.startsWith('image/')) {
    const read = textOf(new Uint8Array(await file.arrayBuffer()))
    if ('refused' in read) return read
    const data = base64Of(new TextEncoder().encode(read.text))
    return { type: 'document', size: data.length, content: [{ type: 'file', filename: file.name, mimeType: file.type || 'text/plain', data }] }
  }
  const image = await decoded(file)
  if (image === null) return { refused: 'the browser cannot read this image' }
  const side = Math.max(image.naturalWidth, image.naturalHeight)
  let mimeType = file.type
  let bytes: Uint8Array
  if (AS_IS.includes(file.type) && side <= IMAGE_SIDE && file.size <= IMAGE_AS_IS) bytes = new Uint8Array(await file.arrayBuffer())
  else {
    const scale = Math.min(1, IMAGE_SIDE / side)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')!
    // A JPEG has no transparency: what was transparent becomes white, not black.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
    if (blob === null) return { refused: 'the browser cannot read this image' }
    mimeType = 'image/jpeg'
    bytes = new Uint8Array(await blob.arrayBuffer())
  }
  const data = base64Of(bytes)
  return { type: 'image', size: data.length, content: [{ type: 'image', image: `data:${mimeType};base64,${data}`, filename: file.name }] }
}

/** The image drawn by the browser, its orientation applied; null if it cannot read it. */
function decoded(file: File): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    image.src = url
  })
}

/**
 * Agora's attachment adapter: each file prepared when it is added, so a refusal is said at once and
 * nothing is attached; `refused` says it. The bytes of what the composer holds are counted against the
 * prompt's maximum until it is sent (`sent`).
 */
export function attachmentAdapter(caps: PromptCapabilities, refused: (name: string, why: string) => void): AttachmentAdapter & { sent(): void } {
  const sizes = new Map<string, number>()
  const prepared = new Map<string, CompleteAttachment['content']>()
  return {
    accept: acceptOf(caps) ?? '*',
    async add({ file }): Promise<PendingAttachment> {
      const result = await prepare(file, caps)
      if ('refused' in result) {
        refused(file.name, result.refused)
        throw new Error(result.refused)
      }
      const total = [...sizes.values()].reduce((a, b) => a + b, 0)
      if (total + result.size > TOTAL_MAX) {
        refused(file.name, 'attachments are limited to 12 MiB in all')
        throw new Error('too large')
      }
      const id = crypto.randomUUID()
      sizes.set(id, result.size)
      prepared.set(id, result.content)
      return { id, type: result.type, name: file.name, contentType: file.type, file, status: { type: 'requires-action', reason: 'composer-send' } }
    },
    async remove(attachment) {
      sizes.delete(attachment.id)
      prepared.delete(attachment.id)
    },
    async send(attachment): Promise<CompleteAttachment> {
      return { ...attachment, status: { type: 'complete' }, content: prepared.get(attachment.id) ?? [] }
    },
    sent() {
      sizes.clear()
      prepared.clear()
    },
  }
}

// Carried over from archive/pre-design-cleanup-2026-09-05:packages/acp/src/journaling-stream.ts
// (commit archive tag, findings §7); changes: none to the framing logic — the module is renamed
// framing.ts and the P4 ceiling/UTF-8 rules are documented in execution.md.
import { createHash } from 'node:crypto'

export type Direction = 'client_to_agent' | 'agent_to_client'

/** Receives one complete NDJSON frame's raw text (no trailing newline) and durably commits it. */
export type PersistFrame = (direction: Direction, frameText: string) => Promise<unknown>

export interface DuplexByteStream {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
}

export const MAX_FRAME_BYTES = 32 * 1024 * 1024

export class FrameTooLargeError extends Error {
  readonly code = 'acp_frame_too_large'

  constructor(bytes: number) {
    super(`ACP frame exceeded ${MAX_FRAME_BYTES} bytes without a newline (${bytes} buffered) — refusing to keep growing`)
    this.name = 'FrameTooLargeError'
  }
}

export function frameDigest(frame: Uint8Array): string {
  return createHash('sha256').update(frame).digest('hex')
}

class NdJsonFrameBuffer {
  private pending = new Uint8Array()

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.pending.byteLength + chunk.byteLength)
    merged.set(this.pending)
    merged.set(chunk, this.pending.byteLength)

    const frames: Uint8Array[] = []
    let frameStart = 0
    // Scanning starts where the previous scan stopped, not at zero: a full rescan per chunk is
    // quadratic in the size of a large frame (findings §1).
    for (let index = this.pending.byteLength; index < merged.byteLength; index += 1) {
      if (merged[index] === 0x0a) {
        frames.push(merged.slice(frameStart, index + 1))
        frameStart = index + 1
      }
    }
    this.pending = merged.slice(frameStart)
    if (this.pending.byteLength > MAX_FRAME_BYTES) throw new FrameTooLargeError(this.pending.byteLength)
    return frames
  }

  flush(): Uint8Array | null {
    if (this.pending.byteLength === 0) return null
    const frame = this.pending
    this.pending = new Uint8Array()
    return frame
  }
}

const decoder = new TextDecoder()

function frameText(frame: Uint8Array): string {
  const text = decoder.decode(frame).trim()
  return text
}

function journalingWritable(output: WritableStream<Uint8Array>, persist: PersistFrame, direction: Direction) {
  const writer = output.getWriter()
  const frames = new NdJsonFrameBuffer()

  return new WritableStream<Uint8Array>({
    async write(chunk) {
      for (const frame of frames.push(chunk)) {
        await persist(direction, frameText(frame))
        await writer.write(frame)
      }
    },
    async close() {
      const finalFrame = frames.flush()
      if (finalFrame) {
        await persist(direction, frameText(finalFrame))
        await writer.write(finalFrame)
      }
      await writer.close()
    },
    abort(reason) {
      return writer.abort(reason)
    },
  })
}

export type OnDiagnostic = (diagnostic: { readonly direction: Direction; readonly errorClass: string; readonly size: number; readonly digest: string }) => Promise<void> | void

function journalingReadable(input: ReadableStream<Uint8Array>, persist: PersistFrame, direction: Direction) {
  const reader = input.getReader()
  const frames = new NdJsonFrameBuffer()
  const queuedFrames: Uint8Array[] = []
  let inputClosed = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (queuedFrames.length === 0 && !inputClosed) {
        const { value, done } = await reader.read()
        if (done) {
          inputClosed = true
          const finalFrame = frames.flush()
          if (finalFrame) queuedFrames.push(finalFrame)
          break
        }
        if (value) queuedFrames.push(...frames.push(value))
      }

      const frame = queuedFrames.shift()
      if (frame) {
        await persist(direction, frameText(frame))
        controller.enqueue(frame)
        return
      }
      controller.close()
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

export function journalDuplexStream(inner: DuplexByteStream, persist: PersistFrame): DuplexByteStream {
  return {
    writable: journalingWritable(inner.writable, persist, 'client_to_agent'),
    readable: journalingReadable(inner.readable, persist, 'agent_to_client'),
  }
}

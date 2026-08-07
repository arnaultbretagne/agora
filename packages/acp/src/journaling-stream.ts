/**
 * Raw-frame capture strictly below `ndJsonStream`, proven necessary by packages/acp/SPIKE.md:
 * the typed SDK's generated parsers strip unknown members and `JSON.parse` loses precision on
 * ACP's uint64 fields. This module frames NDJSON and commits each complete frame — via the
 * caller-supplied `persist` — BEFORE forwarding it onward in either direction, exactly the seam
 * the spike validated ("outbound commit precedes Agent handling", "inbound commit precedes
 * Client handling"). It knows nothing about ACP semantics or Postgres; see store-persist.ts for
 * that wiring.
 */

export type Direction = 'client_to_agent' | 'agent_to_client'

/** Receives one complete NDJSON frame's raw text (no trailing newline) and durably commits it. */
export type PersistFrame = (direction: Direction, frameText: string) => Promise<void>

export interface DuplexByteStream {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
}

const decoder = new TextDecoder()

/**
 * The largest single NDJSON frame this will assemble before giving up.
 *
 * There has to be one. A peer that never emits a newline — a wedged harness, a runaway tool result,
 * a frame that simply is enormous — otherwise grows `pending` without limit, and the control plane
 * holds one of these buffers per direction per live Session. Nothing else in the path bounds it.
 *
 * 32 MiB is far above any real ACP frame (the largest observed are model replies and tool outputs,
 * orders of magnitude smaller) and far below what would threaten this process. Exceeding it throws,
 * which fails the connection closed — the right outcome, because a frame that cannot be journaled
 * must never be forwarded: docs/specs/04's whole guarantee is that the commit precedes the handling.
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024

export class FrameTooLargeError extends Error {
  readonly code = 'acp_frame_too_large'

  constructor(bytes: number) {
    super(`ACP frame exceeded ${MAX_FRAME_BYTES} bytes without a newline (${bytes} buffered) — refusing to keep growing`)
    this.name = 'FrameTooLargeError'
  }
}

class NdJsonFrameBuffer {
  private pending = new Uint8Array()

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.pending.byteLength + chunk.byteLength)
    merged.set(this.pending)
    merged.set(chunk, this.pending.byteLength)

    const frames: Uint8Array[] = []
    let frameStart = 0
    // Scanning starts where the previous scan stopped, not at zero. The old code rescanned the whole
    // accumulated buffer on every chunk, which is quadratic in the size of a large frame — a 32 MiB
    // reply arriving in 64 KiB chunks meant ~500 passes over an ever-growing array, on the hot path
    // for every frame in both directions.
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

function frameText(frame: Uint8Array): string {
  return decoder.decode(frame).trim()
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

/**
 * Wraps a supplied duplex byte stream (the Session's ACP bridge, or an in-memory pair in tests)
 * so every complete frame commits via `persist` before it reaches the wire (outbound) or the SDK
 * (inbound). `outbound`/`inbound` name directions from OUR side, which is always the ACP Client.
 */
export function journalDuplexStream(inner: DuplexByteStream, persist: PersistFrame): DuplexByteStream {
  return {
    writable: journalingWritable(inner.writable, persist, 'client_to_agent'),
    readable: journalingReadable(inner.readable, persist, 'agent_to_client'),
  }
}

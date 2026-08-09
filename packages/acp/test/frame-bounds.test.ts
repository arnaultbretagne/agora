import assert from 'node:assert/strict'
import test from 'node:test'
import { FrameTooLargeError, MAX_FRAME_BYTES, journalDuplexStream, type Direction } from '../src/journaling-stream.js'

/**
 * P11 "oversized ACP frame/update flood".
 *
 * The NDJSON framing under the typed SDK buffered whatever arrived until it saw a newline, with no
 * ceiling — so a peer that never sent one grew the buffer without limit, and the control plane
 * holds one of these per direction per live Session. It also rescanned the entire accumulated
 * buffer on every chunk, which is quadratic in the size of a large frame.
 */

function collect(): { stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }; written: Uint8Array[] } {
  const written: Uint8Array[] = []
  return {
    stream: {
      readable: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      writable: new WritableStream<Uint8Array>({ write: (chunk) => void written.push(chunk) }),
    },
    written,
  }
}

async function writeAll(chunks: readonly Uint8Array[], persist: (d: Direction, f: string) => Promise<void>) {
  const inner = collect()
  const journaled = journalDuplexStream(inner.stream, persist)
  const writer = journaled.writable.getWriter()
  for (const chunk of chunks) await writer.write(chunk)
  await writer.close()
}

const utf8 = (s: string) => new TextEncoder().encode(s)

test('required: frames split across arbitrary chunk boundaries are reassembled exactly once each', async () => {
  const frames: string[] = []
  const payload = '{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n{"jsonrpc":"2.0","id":3,"method":"c"}\n'
  // One byte at a time is the worst case for a buffer that only scans what is new — if the scan
  // offset is wrong by even one byte, a newline is missed and two frames merge into one.
  await writeAll(
    [...payload].map((ch) => utf8(ch)),
    async (_d, f) => void frames.push(f),
  )
  assert.deepEqual(frames, ['{"jsonrpc":"2.0","id":1,"method":"a"}', '{"jsonrpc":"2.0","id":2,"method":"b"}', '{"jsonrpc":"2.0","id":3,"method":"c"}'])
})

test('required: several frames arriving in a single chunk are each committed separately', async () => {
  const frames: string[] = []
  await writeAll([utf8('{"id":1}\n{"id":2}\n{"id":3}\n')], async (_d, f) => void frames.push(f))
  assert.deepEqual(frames, ['{"id":1}', '{"id":2}', '{"id":3}'])
})

test('required: a peer that never sends a newline is cut off instead of growing the buffer for ever', async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(0x41) // a megabyte of 'A', no newline anywhere
  await assert.rejects(
    async () => {
      // 33 MiB of it: one more than the ceiling, so the refusal is the ceiling's doing and not the
      // test running out of anything else.
      await writeAll(Array.from({ length: 33 }, () => chunk), async () => {})
    },
    (error: unknown) => {
      assert.ok(error instanceof FrameTooLargeError || /frame exceeded/i.test(String(error)), `expected a frame-size refusal, got ${String(error)}`)
      return true
    },
    'an unbounded buffer in the control plane is a memory-exhaustion path, one per direction per Session',
  )
})

test('a frame comfortably under the ceiling still goes through — the bound is a ceiling, not a cliff', async () => {
  const frames: string[] = []
  const big = 'x'.repeat(2 * 1024 * 1024)
  await writeAll([utf8(`{"big":"${big}"}\n`)], async (_d, f) => void frames.push(f))
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.length, big.length + 10)
  assert.ok(MAX_FRAME_BYTES > 2 * 1024 * 1024)
})

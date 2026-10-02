// Controlled stdio peer for raw framing, output pressure and blocked stdin tests.
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.argv[2]
const directory = process.argv[3]!
const TOTAL = 20_000

async function write(line: string | Buffer): Promise<void> {
  if (!process.stdout.write(line)) await once(process.stdout, 'drain')
}
if (mode === 'split') {
  const bytes = Buffer.from('  {"jsonrpc":"2.0","id":9007199254740993,"_meta":{"text":"été ☃"}}  \nsecond\n')
  for (const byte of bytes) await write(Buffer.from([byte]))
} else if (mode === 'oversized') {
  for (let i = 0; i < 257; i++) await write(Buffer.alloc(64 * 1024, 0x78))
  await write('\n')
} else if (mode === 'stream') {
  for (let i = 0; i < TOTAL; i++) {
    await write(`${String(i)} ${'x'.repeat(1024)}\n`)
    if (i % 100 === 0) writeFileSync(`${directory}/progress`, String(i))
  }
  writeFileSync(`${directory}/done`, 'done')
} else if (mode === 'holds') {
  // Like opencode with its database: reads its native file once, at start, and answers from memory.
  const path = `${directory}/native/state.txt`
  const state = existsSync(path) ? readFileSync(path, 'utf8') : null
  writeFileSync(`${directory}/started`, String(process.pid))
  for await (const line of createInterface({ input: process.stdin })) {
    const { id } = JSON.parse(line) as { id: unknown }
    await write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { state, pid: process.pid } })}\n`)
  }
} else if (mode === 'stdin') {
  const timer = setInterval(() => {
    if (existsSync(`${directory}/read`)) {
      clearInterval(timer)
      process.stdin.pipe(process.stdout)
    }
  }, 10)
}
// Keep the process alive after writing; its lifetime is independent of any bridge connection.
setInterval(() => {}, 1000)

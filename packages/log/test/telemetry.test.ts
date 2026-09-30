import assert from 'node:assert/strict'
import { it } from 'node:test'
import { measured, telemetry } from '../src/telemetry.ts'

it('measurement ends after the operation settles and preserves its result despite a failing sink', async () => {
  let resolve!: (value: number) => void
  const operation = new Promise<number>((done) => { resolve = done })
  const lines: Record<string, unknown>[] = []
  const result = measured({ operation: 'capture', stage: 'capture_commit', receiveOrdinal: '9007199254740993' },
    () => operation, (line) => { lines.push(JSON.parse(line)); throw new Error('sink failed') })
  assert.equal(lines.length, 0)
  resolve(42)
  assert.equal(await result, 42)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.outcome, 'succeeded')
  assert.equal(lines[0]!.receiveOrdinal, '9007199254740993')
  assert.ok(Number(lines[0]!.durationMs) >= 0)
})

it('failed measurements retain the original error and redact its content and untrusted stages', async () => {
  const error = new Error('PROMPT_TOKEN_HEADER_SECRET'), lines: string[] = []
  await assert.rejects(measured({ operation: 'capture', stage: 'capture_commit', error, token: error.message },
    async () => { throw error }, (line) => lines.push(line)), (value) => value === error)
  assert.equal(JSON.parse(lines[0]!).outcome, 'failed')
  telemetry({ stage: error.message, requestPosition: error.message, durationMs: Infinity }, (line) => lines.push(line))
  assert.equal(lines[1], '{}')
  assert.ok(lines.every((line) => !line.includes(error.message)))
})

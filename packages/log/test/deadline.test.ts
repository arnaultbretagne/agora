// The deadline's and the token's arithmetic (src/deadline.ts), played with production's values over hours: no clock,
// no process — a sandbox kept by work its agent left running, step by step.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextDeadline, tokenDue, tokenLife, working } from '../src/deadline.ts'

test('C81 production values, work running 6 hours after one prompt: a new token before each one runs out, past 70 minutes and to the end, every deadline half a token before it', () => {
  // LEASE_SECONDS 600, a renewal step of 60 s, tokens of an hour, the ceiling of 6 h.
  const lease = 600, step = 60_000, life = tokenLife(3600, lease), ceiling = 21_600
  assert.equal(life, 3600)
  const prompt = 0
  let token = { from: prompt, until: prompt + life * 1000 }
  const tokens = [token]
  let deadline = 0
  for (let now = prompt; ; now += step) {
    const next = nextDeadline(now, lease, prompt, ceiling)
    if (next <= now) break
    if (tokenDue(token.until, next, life)) {
      assert.ok(now < token.until, `renewed before its end at ${String(now / 60_000)} min`)
      token = { from: now, until: now + life * 1000 }
      tokens.push(token)
    }
    assert.ok(token.until - next >= (life / 2) * 1000, `at ${String(now / 60_000)} min`)
    deadline = next
  }
  // The sandbox lived to the ceiling, its token valid all along: renewed every 21 minutes, past 70 minutes and to the end.
  assert.equal(deadline, prompt + ceiling * 1000)
  assert.deepEqual(tokens.map((t) => t.from / 60_000), [0, 21, 42, 63, 84, 105, 126, 147, 168, 189, 210, 231, 252, 273, 294, 315, 336])
  // At 70 minutes, past what the token used to last, the one in place (handed at 63) runs to 123.
  const at70 = tokens.filter((t) => t.from <= 70 * 60_000).at(-1)!
  assert.equal(at70.until / 60_000, 123)
  assert.ok(tokens.at(-1)!.until > deadline)
})

test('C81 control: a token far from its end is not renewed', () => {
  assert.equal(tokenDue(3_600_000, 600_000, 3600), false)
  assert.equal(tokenDue(3_600_000, 1_800_001, 3600), true)
})

test('E40 work is what the bridge did not list as the first prompt left, whatever the clocks', () => {
  const harness = { pid: 12, startedAt: '2026-11-26T10:45:20.010Z' }
  // Started 27 ms "before" the prompt's time in another clock: still work, since the baseline did not list it.
  const sh = { pid: 37, parent: 29, command: 'sh', startedAt: '2026-11-26T10:45:21.279Z' }
  assert.equal(working([{ ...harness, parent: 1, command: 'claude' }, sh], [harness]), true)
  // The harness's own, read again 10 ms off: not work.
  assert.equal(working([{ pid: 12, parent: 1, command: 'claude', startedAt: '2026-11-26T10:45:20.020Z' }], [harness]), false)
  // A pid used again by another process, later: work.
  assert.equal(working([{ pid: 12, parent: 1, command: 'sleep', startedAt: '2026-11-26T11:00:00.000Z' }], [harness]), true)
  assert.equal(working([], [harness]), false)
})

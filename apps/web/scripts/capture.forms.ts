// Captures the forms a preview shows (test/fixtures/forms.json; docs/specs/preview.md, "The conversations"): a real run
// of the log, real bridges and the mock agent, whose `/question` sends Claude Code's AskUserQuestion as claude-agent-acp
// 0.106.0 does (packages/mock-agent/src/forms.ts). Two conversations, each waiting on its form: one question of options,
// and two questions. Run from the log package:
//   cd packages/log && node test/run.ts ../../apps/web/scripts/capture.forms.ts
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { encode } from '../../../packages/log/src/index.ts'
import { database, Lab, until } from '../../../packages/log/test/support.ts'

test('capture the forms fixture', async (t) => {
  const db = await database()
  const lab = await Lab.start({ db })
  t.after(async () => {
    await lab.close()
    await db.drop()
  })
  const workstreams = []
  for (const [first, ask] of [
    ['Pick the service’s database', '/question'],
    ['Plan the release checks', '/question several'],
  ] as const) {
    const ws = await lab.workstream()
    await lab.open(ws)
    assert.ok((await lab.write(ws, first)).accepted)
    await lab.turn(ws, 'done')
    assert.ok((await lab.write(ws, ask)).accepted)
    await until('its form pending', async () => [...(await lab.state(ws)).permissions.values()].some((p) => p.method === 'elicitation/create'))
    await lab.workstreams.projections.run(ws)
    workstreams.push({ id: ws, parent: null, entries: [...(await lab.entries(ws))] })
  }
  await writeFile(new URL('../test/fixtures/forms.json', import.meta.url), `${encode({ capturedAt: new Date().toISOString(), workstreams })}\n`)
})

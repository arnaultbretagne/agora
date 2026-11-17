// Captures the delegation a preview shows (test/fixtures/delegation.json; docs/specs/preview.md, "The conversations"):
// a real run of the log, its delegation engine and Agora's MCP server, real bridges and the mock agent. A delegator
// starts a delegate by `spawn_agent`; the delegate's agent asks a permission and waits; Agora tells the delegator,
// whose turn on it is done. Both Workstreams' entries, at that point. Run from the log package:
//   cd packages/log && node test/run.ts ../../apps/web/scripts/capture.delegation.ts
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createMcpServer, encode } from '../../../packages/log/src/index.ts'
import { database, freePort, grants, Lab, until } from '../../../packages/log/test/support.ts'

test('capture the delegation fixture', async (t) => {
  // Where the mock agent's `/spawn_agent` calls Agora's MCP server: the lab has no gateway (packages/mock-agent).
  const port = await freePort()
  process.env.AGORA_MOCK_MCP = `http://127.0.0.1:${String(port)}/mcp`
  const db = await database()
  const lab = await Lab.start({ db, credentials: grants([]).source, delegations: {} })
  const mcp = createMcpServer(lab.workstreams)
  await new Promise<void>((resolve) => mcp.listen(port, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => mcp.close(resolve))
    await lab.close()
    await db.drop()
  })
  const delegator = await lab.workstream()
  await lab.open(delegator, { profiles: ['agora:delegate'] })
  assert.ok((await lab.write(delegator, 'Ship the release notes')).accepted)
  await lab.turn(delegator, 'done')
  assert.ok((await lab.write(delegator, `/spawn_agent ${JSON.stringify({ instructions: '/permission\nWrite the release notes into demo.txt.', harness: 'mock' })}`)).accepted)
  const delegate = await until('the delegate', async () => (await lab.store.writer.query('SELECT id FROM workstreams WHERE parent=$1', [delegator])).rows[0]?.id as string | undefined)
  await until('its permission', async () => (await lab.state(delegate)).permissions.size === 1)
  // Agora's message, then the delegator's turn on it, done.
  await until('the delegator told', async () => {
    const state = await lab.state(delegator)
    await lab.workstreams.projections.run(delegator)
    const told = (await lab.workstreams.projections.objects(delegator)).some((o) => o.object.type === 'user' && o.object.as === 'agora')
    return told && state.active === null && state.waiting.length === 0
  }, 30_000)
  await lab.workstreams.projections.run(delegate)
  const workstreams = [
    { id: delegator, parent: null, entries: [...(await lab.entries(delegator))] },
    { id: delegate, parent: delegator, entries: [...(await lab.entries(delegate))] },
  ]
  await writeFile(new URL('../test/fixtures/delegation.json', import.meta.url), `${encode({ capturedAt: new Date().toISOString(), workstreams })}\n`)
})

// Captures the delegation a preview shows (test/fixtures/delegation.json; docs/specs/preview.md, "The conversations"):
// a real run of the log, its delegation engine and Agora's MCP server, real bridges and the mock agent. A delegator
// starts a delegate by `spawn_agent`, then runs a command; the delegate's last message comes into it. The delegator
// sends it more by `send_message`: its agent asks a permission and waits; Agora tells the delegator, whose turn on it
// is done. Both Workstreams' entries, at that point. Run from the log package:
//   cd packages/log && node test/run.ts ../../apps/web/scripts/capture.delegation.ts
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createMcpServer, encode } from '../../../packages/log/src/index.ts'
import { database, freePort, gatewayStandIn, grants, Lab, until } from '../../../packages/log/test/support.ts'

test('capture the delegation fixture', async (t) => {
  // Where the mock agent's `/spawn_agent` calls Agora's MCP server: the lab has no gateway (packages/mock-agent), a
  // stand-in for its route forwards each call with the execution's grant.
  const port = await freePort()
  const signer = grants([])
  const gateway = await gatewayStandIn(`http://127.0.0.1:${String(port)}/mcp`, async (execution) => signer.grantOf(execution))
  process.env.AGORA_MOCK_MCP = gateway.url
  const db = await database()
  const lab = await Lab.start({ db, credentials: signer.source, delegations: {} })
  const mcp = createMcpServer(lab.workstreams, signer.key)
  await new Promise<void>((resolve) => mcp.listen(port, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise((resolve) => mcp.close(resolve))
    await lab.close()
    await db.drop()
  })
  const delegator = await lab.workstream()
  await lab.open(delegator, { profiles: ['agora:delegate'] })
  assert.ok((await lab.write(delegator, 'Ship the release notes')).accepted)
  await lab.turn(delegator, 'done')
  /** The delegator's turns, once it has that many and the last is done. */
  const turns = (n: number) => until(`turn ${String(n)} done`, async () => [...(await lab.state(delegator)).turns.values()].length === n && (await lab.state(delegator)).active === null, 30_000)
  assert.ok((await lab.write(delegator, `/spawn_agent ${JSON.stringify({ instructions: '/sleep 3', harness: 'mock' })}`)).accepted)
  const delegate = await until('the delegate', async () => (await lab.store.writer.query('SELECT id FROM workstreams WHERE parent=$1', [delegator])).rows[0]?.id as string | undefined)
  await turns(2)
  // A command of the delegator's, during which the delegate's last message comes (docs/specs/assistant-ui.md, "Folded tools").
  assert.ok((await lab.write(delegator, '/tool-open 6')).accepted)
  await turns(3)
  await lab.workstreams.projections.run(delegator)
  const folded = (await lab.workstreams.projections.objects(delegator)).find((o) => o.object.type === 'user' && o.object.as === 'delegate')
  assert.equal(folded?.object.steered, true, 'the last message came into the command’s turn')
  const turn = folded!.object.turn
  assert.ok((await lab.workstreams.projections.objects(delegator)).some((o) => o.object.type === 'tool' && o.object.turn === turn), 'beside the command')
  assert.ok((await lab.write(delegator, `/send_message ${JSON.stringify({ to: delegate, message: '/permission\nWrite the release notes into demo.txt.' })}`)).accepted)
  await until('its permission', async () => (await lab.state(delegate)).permissions.size === 1, 30_000)
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

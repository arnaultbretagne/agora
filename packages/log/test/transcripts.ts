// Transcripts written as the core projector writes them: a Workstream's turns and elements in `objects`, its row in its
// list, for the tests of search (search.test.ts) and of the MCP server (mcp.test.ts).
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { encode } from '../src/index.ts'

export type Part = string | { tool: string; failed?: boolean } | { thought: string } | { replay: string } | { question: string }
// Far beyond what a projector writes during a test: a crafted row never takes a position the Lab's projector
// holds in the same list.
let place = 1_000_000
/**
 * A Workstream of `owner` as its view's objects hold it: its exchanges, each a user's text and the agent's parts;
 * its row in its list when `changedAt` is given, so that searches can order it.
 */
export async function craft(
  admin: Pool,
  owner: string,
  exchanges: readonly { user: string; agent?: readonly Part[] }[],
  options: { changedAt?: string; parent?: string; title?: string } = {},
): Promise<string> {
  const ws = randomUUID()
  await admin.query('INSERT INTO workstreams(id,owner,parent,root,depth) VALUES($1,$2,$3,$3,$4)', [ws, owner, options.parent ?? null, options.parent ? 1 : 0])
  const object = (kind: string, id: string, value: Record<string, unknown>, type: string | null) =>
    admin.query("INSERT INTO objects(workstream,projector,kind,id,object,first_position,last_position,type) VALUES($1,'core',$2,$3,$4::jsonb,$5,$5,$6)", [
      ws,
      kind,
      id,
      encode(value),
      ++place,
      type,
    ])
  for (const [i, x] of exchanges.entries()) {
    const turn = randomUUID()
    await object('turn', turn, { id: turn, requestPosition: String(i + 1), startedAt: `2026-11-02 09:0${String(i)}:00+00`, status: 'done' }, null)
    await object('element', randomUUID(), { type: 'user', turn, content: [{ type: 'text', text: x.user }] }, 'user')
    for (const p of x.agent ?? []) {
      if (typeof p === 'string') await object('element', randomUUID(), { type: 'agent_message_chunk', turn, text: p }, 'agent_message_chunk')
      else if ('tool' in p) await object('element', randomUUID(), { type: 'tool', turn, title: p.tool, status: p.failed ? 'failed' : 'completed' }, 'tool')
      else if ('thought' in p) await object('element', randomUUID(), { type: 'agent_thought_chunk', turn, text: p.thought }, 'agent_thought_chunk')
      // What a resumed Session replays comes before any prompt of it: no turn.
      else if ('replay' in p) await object('element', randomUUID(), { type: 'agent_message_chunk', text: p.replay }, 'agent_message_chunk')
      else await object('element', randomUUID(), { type: 'question', position: String(place), title: p.question, text: p.question, status: 'pending' }, 'question')
    }
  }
  if (options.changedAt)
    await admin.query("INSERT INTO listings(workstream,owner,position,changed_at,title,row) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [
      ws,
      options.parent ?? owner,
      ++place,
      options.changedAt,
      options.title ?? 'New workstream',
      encode({ id: ws, title: options.title ?? 'New workstream', changedAt: options.changedAt }),
    ])
  return ws
}

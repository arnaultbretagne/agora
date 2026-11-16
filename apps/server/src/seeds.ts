// A preview's conversations at its first start (docs/specs/preview.md, "The conversations"): the client's
// fixtures, written into the empty log as Workstreams of the shared owner — the mock agent's history cut at
// each of its marks, so that every state it went through has its conversation, and the real harnesses'
// histories whole. Nothing is invented beyond them: their entries as recorded, under a Workstream of their own.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'
import { decode, encode, identity, type Entry } from '@agora/log'

/** Where the client's fixtures are, in the repository as in the image. */
export const FIXTURES = join(import.meta.dirname, '..', '..', 'web', 'test', 'fixtures')
/** The real harnesses' histories. */
export const HARNESSES = ['claude-code', 'codex', 'opencode'] as const
/** Held while the conversations are written: two servers starting at once write them once. */
const LOCK = 7_301_734_662

export interface Seed {
  readonly id: string
  /** What it shows: a mark of the mock agent's history, or a harness. */
  readonly name: string
  readonly entries: Entry[]
}

/** The conversations, read from the fixtures. */
export async function seeds(dir = FIXTURES): Promise<Seed[]> {
  const read = async (name: string) => decode(await readFile(join(dir, `${name}.json`), 'utf8')) as { marks?: Record<string, string>; entries: Entry[] }
  const out: Seed[] = []
  const mock = await read('mock')
  for (const [mark, position] of Object.entries(mock.marks ?? {}))
    out.push(under(`mock:${mark}`, mock.entries.filter((e) => BigInt(e.position) <= BigInt(position))))
  for (const harness of HARNESSES) out.push(under(harness, (await read(harness)).entries))
  return out
}

/** A history under a Workstream of its own; its connections renamed with it, which the log keeps unique. */
function under(name: string, entries: Entry[]): Seed {
  const id = identity('preview', name)
  return { id, name, entries: entries.map((e) => ({ ...e, workstream: id, connection: e.connection === null ? null : identity(id, e.connection) })) }
}

/**
 * Writes the conversations for `owner` when the log holds no Workstream yet; a log that holds one is left as it
 * is. Returns how many were written.
 */
export async function writeSeeds(url: string, owner: string, dir = FIXTURES): Promise<number> {
  const list = await seeds(dir)
  const pool = new Pool({ connectionString: url, max: 1 })
  pool.on('error', () => {})
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK])
    if ((await client.query('SELECT 1 FROM workstreams LIMIT 1')).rowCount !== 0) {
      await client.query('ROLLBACK')
      return 0
    }
    for (const s of list) {
      await client.query('INSERT INTO workstreams(id,owner) VALUES($1,$2)', [s.id, owner])
      for (const e of s.entries)
        await client.query(
          `INSERT INTO entries(workstream,position,time,kind,execution,session,content,direction,rpc_kind,method,correlated_method,request_position,rpc_id,command,connection,receive_ordinal)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`,
          [e.workstream, e.position, e.time, e.kind, e.execution, e.session, encode(e.content), e.direction, e.rpc_kind, e.method, e.correlated_method, e.request_position, e.rpc_id === null ? null : encode(e.rpc_id), e.command, e.connection, e.receive_ordinal],
        )
      await client.query('UPDATE workstreams SET last_position=$2 WHERE id=$1', [s.id, s.entries.at(-1)!.position])
    }
    await client.query('COMMIT')
    return list.length
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

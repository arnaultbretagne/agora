// The one move of the files already in PostgreSQL to R2 (docs/specs/files.md, B9; the files ADR): each entry's
// files become references, checked to expand back to what was stored; the views' files too; each anchor's
// bytes become its object. Run as the database owner, holding the files lock shared so that no sweep runs
// meanwhile; the server may run: entries never change, and a view the projector changes meanwhile is left
// for a second run. A row is moved in a transaction of its own: a stop leaves the others as they were, and
// a second run moves only what is left.
import type { Pool, PoolClient } from 'pg'
import { canonical, decode, encode } from './json.ts'
import { digest, expandFiles, FILE_MIN, FILES_LOCK, findFiles, type Files } from './files.ts'

const PAGE = 20

export interface Moved {
  entries: number
  objects: number
  anchors: number
  files: number
}

async function kept(client: PoolClient, files: Files, bytes: ReadonlyMap<string, Buffer>, moved: Moved): Promise<void> {
  const sha256s = [...bytes.keys()].sort()
  const known = new Set((await client.query('SELECT sha256 FROM files WHERE sha256 = ANY($1)', [sha256s])).rows.map((r) => r.sha256 as string))
  for (const sha256 of sha256s)
    if (!known.has(sha256)) {
      await files.put(sha256, bytes.get(sha256)!)
      moved.files++
    }
  await client.query('INSERT INTO files(sha256,size) SELECT * FROM unnest($1::text[], $2::bigint[]) ON CONFLICT DO NOTHING', [
    sha256s,
    sha256s.map((s) => bytes.get(s)!.byteLength),
  ])
}

async function inTransaction(client: PoolClient, run: () => Promise<void>): Promise<void> {
  await client.query('BEGIN')
  try {
    await run()
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export async function moveFiles(owner: Pool, files: Files, log: (line: string) => void = () => {}): Promise<Moved> {
  const moved: Moved = { entries: 0, objects: 0, anchors: 0, files: 0 }
  const client = await owner.connect()
  try {
    await client.query('SELECT pg_advisory_lock_shared($1)', [FILES_LOCK])
    // The entries: a command or an ACP line, never moved before.
    let after: [string, string] = ['00000000-0000-0000-0000-000000000000', '0']
    for (;;) {
      const page = await client.query(
        `SELECT workstream, position, content::text AS content FROM entries
         WHERE (workstream, position) > ($1::uuid, $2::bigint) AND files IS NULL AND kind IN ('command','acp') AND length(content::text) >= $3
         ORDER BY workstream, position LIMIT ${String(PAGE)}`,
        [after[0], after[1], FILE_MIN],
      )
      if (page.rowCount === 0) break
      for (const row of page.rows) {
        after = [row.workstream as string, row.position as string]
        const before = decode(row.content as string)
        const found = findFiles(before)
        if (!found) continue
        await inTransaction(client, async () => {
          await kept(client, files, found.bytes, moved)
          await client.query('UPDATE entries SET content = $3::jsonb, files = $4::jsonb WHERE workstream = $1 AND position = $2', [
            row.workstream,
            row.position,
            encode(found.value),
            JSON.stringify(found.refs),
          ])
          // Checked as stored, with the bytes R2 gives back: expanded, the entry is what it was, every member, number and string.
          const stored = await client.query('SELECT content::text AS content, files FROM entries WHERE workstream = $1 AND position = $2', [row.workstream, row.position])
          const back = new Map<string, Buffer>()
          for (const sha256 of found.bytes.keys()) back.set(sha256, await files.get(sha256))
          const expanded = expandFiles(decode(stored.rows[0].content as string), stored.rows[0].files, back)
          if (canonical(expanded) !== canonical(before)) throw new Error(`entry ${String(row.workstream)}/${String(row.position)} does not expand back`)
        })
        moved.entries++
      }
      log(`entries: ${String(moved.entries)} moved, at ${after.join('/')}`)
    }
    // The views: the projector copied the files; their objects are those of the entries.
    let next: [string, string, string] = ['00000000-0000-0000-0000-000000000000', '', '00000000-0000-0000-0000-000000000000']
    for (;;) {
      const page = await client.query(
        `SELECT workstream, kind, id, last_position, object::text AS object FROM objects
         WHERE (workstream, kind, id) > ($1::uuid, $2, $3::uuid) AND length(object::text) >= $4
         ORDER BY workstream, kind, id LIMIT ${String(PAGE)}`,
        [next[0], next[1], next[2], FILE_MIN],
      )
      if (page.rowCount === 0) break
      for (const row of page.rows) {
        next = [row.workstream as string, row.kind as string, row.id as string]
        const found = findFiles(decode(row.object as string))
        if (!found) continue
        let updated = false
        await inTransaction(client, async () => {
          await kept(client, files, found.bytes, moved)
          // Only the view as it was read: one the projector changed since is left for the next run.
          const done = await client.query('UPDATE objects SET object = $4::jsonb WHERE workstream = $1 AND kind = $2 AND id = $3 AND last_position = $5', [
            row.workstream,
            row.kind,
            row.id,
            encode(found.value),
            row.last_position,
          ])
          updated = done.rowCount === 1
        })
        if (updated) moved.objects++
      }
    }
    // The anchors: their bytes become their object, the record names it.
    for (;;) {
      const page = await client.query(`SELECT id, content FROM anchors WHERE file IS NULL AND content IS NOT NULL ORDER BY id LIMIT 1`)
      if (page.rowCount === 0) break
      const row = page.rows[0]
      const bytes = row.content as Buffer
      const sha256 = digest(bytes)
      await inTransaction(client, async () => {
        await kept(client, files, new Map([[sha256, bytes]]), moved)
        await client.query('UPDATE anchors SET file = $2, content = NULL WHERE id = $1', [row.id, sha256])
      })
      moved.anchors++
    }
    log(`moved: ${String(moved.entries)} entries, ${String(moved.objects)} objects, ${String(moved.anchors)} anchors; ${String(moved.files)} files stored`)
    return moved
  } finally {
    await client.query('SELECT pg_advisory_unlock_shared($1)', [FILES_LOCK]).catch(() => {})
    client.release(true)
  }
}

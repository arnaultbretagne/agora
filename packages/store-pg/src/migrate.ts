import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import type pg from 'pg'
import { createPool, requireDatabaseUrl } from './db.js'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../../contracts/database')

export interface MigrationResult {
  readonly applied: readonly string[]
  readonly alreadyApplied: readonly string[]
}

/**
 * Applies contracts/database/*.sql in filename order (numeric prefixes sort correctly), tracked in
 * public.schema_migrations. Each file wraps its own BEGIN/COMMIT, so it is sent as one statement.
 */
export async function migrate(pool: pg.Pool): Promise<MigrationResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM public.schema_migrations')
  const already = new Set(rows.map((r) => r.filename))

  const applied: string[] = []
  const alreadyApplied: string[] = []

  for (const file of files) {
    if (already.has(file)) {
      alreadyApplied.push(file)
      continue
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    await pool.query(sql)
    await pool.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [file])
    applied.push(file)
  }

  return { applied, alreadyApplied }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href

if (isMain) {
  const pool = createPool(requireDatabaseUrl())
  try {
    const result = await migrate(pool)
    console.log(`applied: ${result.applied.join(', ') || '(none)'}`)
    console.log(`already applied: ${result.alreadyApplied.length}`)
  } finally {
    await pool.end()
  }
}

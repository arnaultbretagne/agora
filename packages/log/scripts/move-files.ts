// Moves the files already in the log's database to R2, once (docs/specs/files.md, B9): as the database owner
// (LOG_MIGRATION_URL), with the files' bucket (FILES_ENDPOINT, FILES_BUCKET, FILES_ACCESS_KEY_ID,
// FILES_SECRET_ACCESS_KEY), the server stopped and the schema applied (migrate.ts). Then VACUUM (FULL) gives
// the space back.
import { Pool } from 'pg'
import { Files } from '../src/files.ts'
import { moveFiles } from '../src/move.ts'

const url = process.env.LOG_MIGRATION_URL
if (!url) throw new Error('LOG_MIGRATION_URL is required')
const pool = new Pool({ connectionString: url })
pool.on('error', () => {})
try {
  await moveFiles(pool, Files.fromEnv(process.env), (line) => console.log(line))
  console.log('files moved')
} finally {
  await pool.end()
}

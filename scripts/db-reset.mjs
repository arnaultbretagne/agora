// Drops and recreates the Agora database, then applies contracts/db/schema.sql from scratch.
// There is no migration tooling by decision: the schema is the whole contract until first release.
//
//   DATABASE_URL    maintenance connection (a database other than the one being reset)
//   AGORA_DATABASE  database to drop/create (default: agora)
import { readFileSync } from 'node:fs'
import pg from 'pg'

const maintenanceUrl = process.env.DATABASE_URL
if (!maintenanceUrl) {
  console.error('DATABASE_URL is required (maintenance connection, e.g. postgres://user:pass@host:5432/postgres)')
  process.exit(2)
}
const database = process.env.AGORA_DATABASE ?? 'agora'
if (!/^[a-z_][a-z0-9_]*$/.test(database)) {
  console.error(`AGORA_DATABASE must be a plain lowercase identifier, got ${JSON.stringify(database)}`)
  process.exit(2)
}
const schema = readFileSync(new URL('../contracts/db/schema.sql', import.meta.url), 'utf8')

const maintenance = new pg.Client({ connectionString: maintenanceUrl })
await maintenance.connect()
try {
  if (maintenance.database === database) throw new Error('DATABASE_URL must not point at the database being reset')
  await maintenance.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  await maintenance.query(`CREATE DATABASE "${database}"`)
} finally {
  await maintenance.end()
}

const target = new URL(maintenanceUrl)
target.pathname = `/${database}`
const client = new pg.Client({ connectionString: target.toString() })
await client.connect()
try {
  await client.query('BEGIN')
  await client.query(schema)
  await client.query('COMMIT')
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  await client.end()
}
console.log(`database ${database} recreated and schema applied`)

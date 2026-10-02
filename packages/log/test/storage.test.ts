// docs/specs/log.md, "Storage": what each role may and may not do, and migrations side by side.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { database, provisioning, RUN } from './support.ts'

test('L25 each role does what it may, then is denied each thing it may not', async (t) => {
  const db = await database()
  const pools = { writer: new Pool({ connectionString: db.urls.writer }), projector: new Pool({ connectionString: db.urls.projector }), anchors: new Pool({ connectionString: db.urls.anchors }) }
  t.after(async () => {
    for (const pool of Object.values(pools)) await pool.end()
    await db.drop()
  })
  const ws = randomUUID(),
    execution = randomUUID(),
    session = randomUUID(),
    connection = randomUUID(),
    anchor = randomUUID()
  const may: [keyof typeof pools, string, unknown[]][] = [
    ['writer', 'INSERT INTO workstreams(id,owner) VALUES($1,$2)', [ws, randomUUID()]],
    ['writer', "INSERT INTO entries(workstream,position,kind,execution,content) VALUES($1,1,'command',$2,'{}')", [ws, execution]],
    ['writer', 'UPDATE workstreams SET last_position=1 WHERE id=$1', [ws]],
    ['writer', "INSERT INTO commands(workstream,id,kind,target,fingerprint,answer,position) VALUES($1,$2,'Create','{}','f','{}',1)", [ws, randomUUID()]],
    ['writer', "INSERT INTO sessions(id,workstream,execution,acp_id,opened_position) VALUES($1,$2,$3,'acp',1)", [session, ws, execution]],
    ['writer', 'UPDATE sessions SET ended_position=1 WHERE id=$1', [session]],
    ['writer', "INSERT INTO diagnostics(id,workstream,execution,connection,receive_ordinal,direction,reason,size,sha256) VALUES($1,$2,$3,$4,1,'in','batch',1,'h')", [randomUUID(), ws, execution, connection]],
    ['writer', 'SELECT id,workstream,execution,session,metadata,time FROM anchors', []],
    ['anchors', 'SELECT workstream,execution,session,kind,position FROM entries', []],
    ['anchors', 'SELECT id,workstream,execution,acp_id,opened_position,ended_position FROM sessions', []],
    ['anchors', "INSERT INTO anchors(id,workstream,execution,session,metadata,content) VALUES($1,$2,$3,$4,'{}','\\x00')", [anchor, ws, execution, session]],
    ['anchors', 'SELECT content FROM anchors WHERE id=$1', [anchor]],
    ['projector', 'SELECT workstream,position,kind,content FROM entries', []],
    ['projector', 'INSERT INTO threads(workstream) VALUES($1)', [ws]],
    ['projector', 'UPDATE threads SET last_position=1 WHERE workstream=$1', [ws]],
    ['projector', "INSERT INTO objects(workstream,projector,kind,id,object,first_position,last_position) VALUES($1,'core','turn',$2,'{}',1,1)", [ws, execution]],
    ['projector', "UPDATE objects SET object='{\"a\":1}' WHERE workstream=$1", [ws]],
    ['projector', "INSERT INTO thread(workstream,position,operation,kind,id,object) VALUES($1,1,'upsert','turn',$2,'{}')", [ws, execution]],
    ['projector', "INSERT INTO checkpoints(workstream,projector,version,position) VALUES($1,'core','1',1)", [ws]],
    ['projector', "UPDATE checkpoints SET position=1 WHERE workstream=$1", [ws]],
    ['projector', 'DELETE FROM objects WHERE workstream=$1', [ws]],
  ]
  for (const [role, sql, values] of may) await assert.doesNotReject(pools[role].query(sql, values), `${role} may: ${sql}`)
  const mayNot: [keyof typeof pools, string, unknown[]][] = [
    ['writer', "UPDATE entries SET content='{}'", []],
    ['writer', 'DELETE FROM entries', []],
    ['writer', "UPDATE commands SET answer='{}'", []],
    ['writer', 'DELETE FROM commands', []],
    ['writer', 'SELECT content FROM anchors', []],
    ['writer', "INSERT INTO objects(workstream,projector,kind,id,object,first_position,last_position) VALUES($1,'core','turn',$2,'{}',1,1)", [ws, randomUUID()]],
    ['writer', "INSERT INTO thread(workstream,position,operation) VALUES($1,2,'reset')", [ws]],
    ['writer', "INSERT INTO checkpoints(workstream,projector,version,position) VALUES($1,'other','1',1)", [ws]],
    ['projector', "INSERT INTO entries(workstream,position,kind,content) VALUES($1,2,'command','{}')", [ws]],
    ['projector', "INSERT INTO commands(workstream,id,kind,target,fingerprint,answer,position) VALUES($1,$2,'Create','{}','f','{}',1)", [ws, randomUUID()]],
    ['projector', "INSERT INTO sessions(id,workstream,execution,acp_id,opened_position) VALUES($1,$2,$3,'acp',1)", [randomUUID(), ws, execution]],
    ['projector', 'SELECT id FROM anchors', []],
    ['projector', "UPDATE thread SET object='{}'", []],
    ['projector', 'DELETE FROM thread', []],
    ['anchors', "INSERT INTO entries(workstream,position,kind,content) VALUES($1,2,'command','{}')", [ws]],
    ['anchors', "INSERT INTO commands(workstream,id,kind,target,fingerprint,answer,position) VALUES($1,$2,'Create','{}','f','{}',1)", [ws, randomUUID()]],
    ['anchors', "INSERT INTO sessions(id,workstream,execution,acp_id,opened_position) VALUES($1,$2,$3,'acp',1)", [randomUUID(), ws, execution]],
    ['anchors', "INSERT INTO objects(workstream,projector,kind,id,object,first_position,last_position) VALUES($1,'core','turn',$2,'{}',1,1)", [ws, randomUUID()]],
    ['anchors', "UPDATE anchors SET metadata='{}'", []],
    ['anchors', 'DELETE FROM anchors', []],
  ]
  for (const [role, sql, values] of mayNot)
    await assert.rejects(pools[role].query(sql, values), (error: { code?: string }) => error.code === '42501', `${role} may not: ${sql}`)
})

const exited = (child: ReturnType<typeof spawn>) =>
  new Promise<{ code: number | null; output: string }>((resolve) => {
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('exit', (code) => resolve({ code, output }))
  })

test('L27 migrations run at once in two databases of one cluster: both succeed, no existing role gains a privilege', async (t) => {
  const server = provisioning()
  const [first, second] = [await database({ empty: true }), await database({ empty: true })]
  const logins = ['writer', 'projector', 'anchors'].map((role) => ({ role, user: `agora_test_${role}_m_${RUN}`, password: randomBytes(24).toString('hex') }))
  t.after(async () => {
    await first.drop()
    await second.drop()
    for (const { user } of logins) await server.query(`DROP ROLE IF EXISTS ${user}`)
    await server.end()
  })
  const roles = async () =>
    (await server.query("SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname")).rows
  const memberships = async () =>
    (await server.query('SELECT r.rolname AS role, m.rolname AS member FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member ORDER BY 1,2')).rows
  const acls = async () => (await server.query('SELECT datname, datacl::text FROM pg_database ORDER BY datname')).rows
  const [rolesBefore, membersBefore, aclsBefore] = [await roles(), await memberships(), await acls()]
  const run = (db: typeof first) => {
    const at = (login: (typeof logins)[number]) => {
      const url = new URL(db.urls.writer)
      url.username = login.user
      url.password = login.password
      return url.href
    }
    const owner = new URL(String(process.env.LOG_TEST_ADMIN_URL))
    owner.pathname = `/${db.name}`
    return exited(
      spawn(process.execPath, [new URL('../scripts/migrate.ts', import.meta.url).pathname], {
        env: {
          ...process.env,
          LOG_MIGRATION_URL: owner.href,
          LOG_PROVISION_LOGINS: 'true',
          LOG_WRITER_URL: at(logins[0]!),
          LOG_PROJECTOR_URL: at(logins[1]!),
          LOG_ANCHORS_URL: at(logins[2]!),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
  }
  const results = await Promise.all([run(first), run(second)])
  for (const result of results) assert.deepEqual([result.code, result.output.trim()], [0, 'log schema ready'])
  const created = new Set(logins.map((l) => l.user))
  // Every role that existed keeps its attributes and memberships.
  assert.deepEqual((await roles()).filter((r) => !created.has(r.rolname)), rolesBefore)
  assert.deepEqual((await memberships()).filter((m) => !created.has(m.member)), membersBefore)
  assert.deepEqual(
    (await memberships()).filter((m) => created.has(m.member)).map((m) => `${m.role} ${m.member}`).sort(),
    logins.map((l) => `agora_${l.role} ${l.user}`).sort(),
  )
  // Other databases are untouched; the new ones are open only to their owner and the log's roles.
  const aclsAfter = await acls()
  assert.deepEqual(aclsAfter.filter((a) => a.datname !== first.name && a.datname !== second.name), aclsBefore.filter((a) => a.datname !== first.name && a.datname !== second.name))
  for (const db of [first, second]) {
    const acl = String(aclsAfter.find((a) => a.datname === db.name)?.datacl)
    const grantees = acl.replace(/[{}"]/g, '').split(',').map((item) => item.split('=')[0])
    assert.deepEqual(grantees.filter((g) => !['agora_writer', 'agora_projector', 'agora_anchors'].includes(g!)).length, 1, acl)
    assert.ok(!grantees.includes(''), `PUBLIC may not connect: ${acl}`)
  }
})

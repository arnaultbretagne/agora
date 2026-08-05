import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { codexSpecificEnv, ensureCodexAuthStub } from '../src/bridge-server.js'

test('required: translates the generic AGORA_* Pod contract into what codex-acp/the real binary need', () => {
  const env = codexSpecificEnv({
    AGORA_BROKER_RELAY_ENDPOINT: 'https://broker-relay.agent.svc.cluster.local:8443',
    AGORA_ONECLI_CA_PATH: '/etc/agora/onecli-ca.pem',
    AGORA_ONECLI_STUBS_DIR: '/etc/agora/onecli-stubs',
  })
  assert.equal(env.HTTPS_PROXY, 'https://broker-relay.agent.svc.cluster.local:8443')
  assert.equal(env.HTTP_PROXY, 'https://broker-relay.agent.svc.cluster.local:8443')
  assert.equal(env.SSL_CERT_FILE, '/etc/agora/onecli-ca.pem')
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/agora/onecli-ca.pem')
  assert.equal(env.NO_BROWSER, '1')
  assert.equal(env.INITIAL_AGENT_MODE, 'agent')
})

test('required: never invents a value — an upstream OneCLI bearer or real provider credential is never among the translated keys', () => {
  const env = codexSpecificEnv({
    AGORA_BROKER_RELAY_ENDPOINT: 'https://broker-relay:8443',
    AGORA_ONECLI_CA_PATH: '/ca.pem',
    AGORA_ONECLI_STUBS_DIR: '/stubs',
  })
  assert.deepEqual(
    Object.keys(env).sort(),
    ['HTTPS_PROXY', 'HTTP_PROXY', 'INITIAL_AGENT_MODE', 'NODE_EXTRA_CA_CERTS', 'NO_BROWSER', 'SSL_CERT_FILE'].sort(),
  )
  assert.doesNotMatch(JSON.stringify(env), /aoc_/, 'no OneCLI proxy bearer shape ever appears')
})

test('required: fails closed (never launches with a partial/silent-default env) if any of the three AGORA_* inputs is missing', () => {
  assert.throws(() => codexSpecificEnv({ AGORA_ONECLI_CA_PATH: '/ca.pem', AGORA_ONECLI_STUBS_DIR: '/stubs' }))
  assert.throws(() => codexSpecificEnv({ AGORA_BROKER_RELAY_ENDPOINT: 'https://x', AGORA_ONECLI_STUBS_DIR: '/stubs' }))
  assert.throws(() => codexSpecificEnv({ AGORA_BROKER_RELAY_ENDPOINT: 'https://x', AGORA_ONECLI_CA_PATH: '/ca.pem' }))
})

test('required: ensureCodexAuthStub writes a structurally-valid, non-secret placeholder auth.json', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-auth-stub-test-'))
  await ensureCodexAuthStub(home)
  const raw = await readFile(join(home, '.codex', 'auth.json'), 'utf8')
  const parsed = JSON.parse(raw) as { tokens: { id_token: string; access_token: string; refresh_token: string } }

  // The id_token must parse as a real JWT shape (3 dot-separated base64url segments) — codex-acp
  // validates this locally before ever touching the network (found live in the spike).
  const segments = parsed.tokens.id_token.split('.')
  assert.equal(segments.length, 3)
  const payload = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
  assert.ok(typeof payload.sub === 'string' && payload.sub.length > 0)

  // Never a real bearer shape, and never derived from anything session-specific.
  assert.doesNotMatch(raw, /aoc_/)
  assert.equal(parsed.tokens.access_token, 'onecli-managed')
  assert.equal(parsed.tokens.refresh_token, 'onecli-managed')
})

test('ensureCodexAuthStub is idempotent — writing twice never fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-auth-stub-test-'))
  await ensureCodexAuthStub(home)
  await assert.doesNotReject(() => ensureCodexAuthStub(home))
})

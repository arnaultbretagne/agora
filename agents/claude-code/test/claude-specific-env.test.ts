import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeSpecificEnv } from '../src/bridge-server.js'

async function seedStub(content: string): Promise<{ stubsDir: string; caPath: string }> {
  const stubsDir = await mkdtemp(join(tmpdir(), 'onecli-stubs-'))
  await writeFile(join(stubsDir, 'claude-code-oauth-token'), content)
  const caPath = join(stubsDir, 'ca.pem')
  await writeFile(caPath, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n')
  return { stubsDir, caPath }
}

test('required: translates the generic AGORA_* Pod contract into what claude-agent-acp/the real CLI need', async () => {
  const { stubsDir, caPath } = await seedStub('onecli-managed-placeholder\n')
  const env = await claudeSpecificEnv({
    AGORA_BROKER_RELAY_ENDPOINT: 'https://broker-relay.agent.svc.cluster.local:8443',
    AGORA_ONECLI_CA_PATH: caPath,
    AGORA_ONECLI_STUBS_DIR: stubsDir,
  })
  assert.equal(env.HTTPS_PROXY, 'https://broker-relay.agent.svc.cluster.local:8443')
  assert.equal(env.HTTP_PROXY, 'https://broker-relay.agent.svc.cluster.local:8443')
  assert.equal(env.NODE_EXTRA_CA_CERTS, caPath)
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'onecli-managed-placeholder')
})

test('required: never invents a value — an upstream OneCLI bearer or real provider credential is never among the translated keys', async () => {
  const { stubsDir, caPath } = await seedStub('placeholder')
  const env = await claudeSpecificEnv({
    AGORA_BROKER_RELAY_ENDPOINT: 'https://broker-relay:8443',
    AGORA_ONECLI_CA_PATH: caPath,
    AGORA_ONECLI_STUBS_DIR: stubsDir,
  })
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS'].sort())
  assert.doesNotMatch(JSON.stringify(env), /aoc_/, 'no OneCLI proxy bearer shape ever appears')
})

test('required: fails closed (never launches with a partial/silent-default env) if any of the three AGORA_* inputs is missing', async () => {
  const { stubsDir, caPath } = await seedStub('placeholder')
  await assert.rejects(() => claudeSpecificEnv({ AGORA_ONECLI_CA_PATH: caPath, AGORA_ONECLI_STUBS_DIR: stubsDir }))
  await assert.rejects(() => claudeSpecificEnv({ AGORA_BROKER_RELAY_ENDPOINT: 'https://x', AGORA_ONECLI_STUBS_DIR: stubsDir }))
  await assert.rejects(() => claudeSpecificEnv({ AGORA_BROKER_RELAY_ENDPOINT: 'https://x', AGORA_ONECLI_CA_PATH: caPath }))
})

test('required: fails closed if the stub directory exists but the expected stub file does not', async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), 'onecli-stubs-empty-'))
  await assert.rejects(() =>
    claudeSpecificEnv({
      AGORA_BROKER_RELAY_ENDPOINT: 'https://x',
      AGORA_ONECLI_CA_PATH: '/does/not/matter',
      AGORA_ONECLI_STUBS_DIR: emptyDir,
    }),
  )
})

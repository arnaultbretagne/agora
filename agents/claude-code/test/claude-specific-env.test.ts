import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeSpecificEnv, defaultAgentCommand } from '../src/bridge-server.js'

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
  // An exact allowlist on purpose: this test's job is that nothing sneaks into the harness's
  // environment unnoticed, so a new key must be added here deliberately and be visibly non-secret.
  // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 turns off the harness's bubblewrap sandbox, which cannot
  // create its network namespace inside gVisor — see the reasoning at the assignment site.
  assert.deepEqual(
    Object.keys(env).sort(),
    ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'HTTPS_PROXY', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS'].sort(),
  )
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

test('required: a reviewed persona becomes the harness\'s own --agent flag, and no persona means no flag at all', async () => {
  const previous = process.env['AGORA_PERSONA']
  try {
    delete process.env['AGORA_PERSONA']
    const withoutPersona = await defaultAgentCommand()
    assert.equal(withoutPersona.includes('--agent'), false, "omitting the flag is not the same request as `--agent ''`")

    process.env['AGORA_PERSONA'] = 'reviewer'
    const withPersona = await defaultAgentCommand()
    const at = withPersona.indexOf('--agent')
    assert.ok(at > 0, 'the flag is present')
    assert.equal(withPersona[at + 1], 'reviewer', 'and carries the persona name as its own argument, never concatenated')

    // Empty/whitespace must behave like absent: the controller already refuses an unreviewed
    // persona, but a Pod handed an empty variable must not degrade into `--agent ''`.
    process.env['AGORA_PERSONA'] = ''
    assert.equal((await defaultAgentCommand()).includes('--agent'), false)
  } finally {
    if (previous === undefined) delete process.env['AGORA_PERSONA']
    else process.env['AGORA_PERSONA'] = previous
  }
})

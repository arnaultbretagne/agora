// Minting a session (docs/credentials.md), against a stand-in for Agent Vault's API.
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { AgentVault } from '../src/index.ts'

const seen: { authorization: string | undefined; path: string | undefined; body: Record<string, unknown> }[] = []
let answer: { status: number; body: unknown } = { status: 200, body: { token: 'jeton-proxy', expires_at: '2030-01-01T00:00:00Z', av_addr: 'http://x' } }
const api = createServer((req: IncomingMessage, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    seen.push({ authorization: req.headers.authorization, path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> })
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer.body))
  })
})
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
after(() => new Promise<void>((resolve) => api.close(() => resolve())))

const tokenFile = join(mkdtempSync(join(tmpdir(), 'vault-')), 'token')
writeFileSync(tokenFile, 'jeton-agent\n')
const vault = new AgentVault({
  api: `http://127.0.0.1:${String((api.address() as { port: number }).port)}/`,
  proxy: 'agent-vault-proxy:14322',
  vault: 'default',
  agentTokenFile: tokenFile,
})

describe('AgentVault', () => {
  it('mints a proxy-only session with the agent token and returns what the bridge needs', async () => {
    const credentials = await vault.mint({ label: 'agora sbx-0123456789', ttlSeconds: 3600 })
    assert.deepEqual(credentials, { proxy: 'agent-vault-proxy:14322', token: 'jeton-proxy', expiresAt: '2030-01-01T00:00:00Z' })
    const request = seen.at(-1)
    assert.equal(request?.path, '/v1/sessions')
    assert.equal(request?.authorization, 'Bearer jeton-agent')
    assert.deepEqual(request?.body, { vault: 'default', vault_role: 'proxy', ttl_seconds: 3600, label: 'agora sbx-0123456789' })
  })

  it('refuses a lifetime outside Agent Vault’s bounds without asking it', async () => {
    const before = seen.length
    await assert.rejects(vault.mint({ label: 'x', ttlSeconds: 60 }), /hors bornes/)
    await assert.rejects(vault.mint({ label: 'x', ttlSeconds: 8 * 24 * 3600 }), /hors bornes/)
    assert.equal(seen.length, before)
  })

  it('reports Agent Vault’s refusal with its reason', async () => {
    answer = { status: 403, body: { error: 'Forbidden: vault member role required' } }
    await assert.rejects(vault.mint({ label: 'x', ttlSeconds: 600 }), (error: Error & { status?: number }) => error.status === 403 && /member role required/.test(error.message))
  })
})

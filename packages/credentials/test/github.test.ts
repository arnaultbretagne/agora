// The merge card's side of the credentials (docs/specs/merge.md): Agora's own `merge` grant, a write opening Agora's MCP
// server, the card's state from GitHub's answer, and the operator's GitHub through the gateway, its requests recorded.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AGORA_MCP_HOST, compileProfile, GrantSigner, mcpServers, OperatorGitHub, stateOf, type PullRequest } from '../src/index.ts'

function signer(): GrantSigner {
  const { privateKey } = generateKeyPairSync('ed25519')
  const keyFile = join(mkdtempSync(join(tmpdir(), 'github-')), 'key.pem')
  writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }))
  return new GrantSigner({ proxy: 'gateway:3000', keyFile, keyId: 'k1', issuer: 'agora', audience: 'agora-gateway' })
}
const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { grants: { host: string; path?: string; methods?: string[]; identity?: string }[] }

const PULL: PullRequest = { number: 7, title: 't', url: 'u', open: true, merged: false, draft: false, base: 'main', head: 'feat/x', sha: 'abc', author: 'agora-contributor[bot]', mergeableState: 'clean', mergeSha: '' }

describe('the merge card’s credentials', () => {
  it('the merge profile: Agora’s own, a pull request and its reviews read and its merge, as the operator; never compiled for an execution', async () => {
    assert.throws(() => compileProfile('merge'), /unknown profile/)
    const { token } = await signer().mint({ label: 'agora merge', ttlSeconds: 300, profiles: ['merge'], address: '10.244.0.9' })
    const grants = claims(token).grants
    assert.ok(grants.every((g) => g.host === 'api.github.com' && g.identity === 'operator'))
    const covers = (method: string, path: string) => grants.some((g) => new RegExp(g.path!).test(path) && g.methods!.includes(method))
    for (const [method, path, expected] of [
      ['GET', '/repos/o/r/pulls/7', true],
      ['GET', '/repos/o/r/pulls/7/reviews?per_page=100', true],
      ['PUT', '/repos/o/r/pulls/7/merge', true],
      ['POST', '/repos/o/r/pulls/7/reviews', false],
      ['PUT', '/repos/o/r/contents/a.txt', false],
      ['GET', '/repos/o/r/pulls/7/files', false],
      ['DELETE', '/repos/o/r/git/refs/heads/main', false],
      ['PATCH', '/repos/o/r/pulls/7', false],
    ] as const) assert.equal(covers(method, path), expected, `${method} ${path}`)
  })

  it('G1 a repository’s write opens Agora’s MCP endpoint and its server for session/new; a read does not', () => {
    assert.ok(compileProfile('github:o/r:write').some((g) => g.host === AGORA_MCP_HOST && g.path === '^/mcp$'))
    assert.ok(!compileProfile('github:o/r:read').some((g) => g.host === AGORA_MCP_HOST))
    assert.deepEqual(mcpServers(['github:o/r:write']).map((s) => s.name), ['agora'])
    assert.deepEqual(mcpServers(['github:o/r:write', 'agora:read']).map((s) => s.name), ['agora'])
    assert.deepEqual(mcpServers(['github:o/r:read', 'github:o/r:review']), [])
  })

  it('G3 the card’s state, from each mergeable_state of the table', () => {
    const cases: [Partial<PullRequest>, boolean, string][] = [
      [{ mergeableState: 'clean' }, false, 'ready'],
      [{ mergeableState: 'has_hooks' }, false, 'ready'],
      [{ mergeableState: 'blocked' }, false, 'review'],
      [{ mergeableState: 'blocked' }, true, 'blocked'],
      [{ mergeableState: 'unstable' }, true, 'checks'],
      [{ mergeableState: 'dirty' }, true, 'conflicts'],
      [{ mergeableState: 'behind' }, true, 'behind'],
      [{ mergeableState: 'draft' }, true, 'draft'],
      [{ draft: true, mergeableState: 'clean' }, true, 'draft'],
      [{ mergeableState: null }, false, 'computing'],
      [{ open: false }, false, 'closed'],
      [{ open: false, merged: true }, false, 'merged'],
    ]
    for (const [pull, approved, expected] of cases) assert.equal(stateOf({ ...PULL, ...pull }, approved), expected, JSON.stringify(pull))
  })

  it('the operator’s GitHub through the gateway: the pull request read, its reviews when blocked, a squash merge of the sha given; GitHub’s refusal kept', async () => {
    const asked: { method: string; path: string; body?: string; token: string }[] = []
    const answers: Record<string, { status: number; body: unknown }> = {
      'GET /repos/o/r/pulls/7': { status: 200, body: { number: 7, title: 'Add x', html_url: 'https://github.com/o/r/pull/7', state: 'open', merged: false, draft: false, base: { ref: 'main' }, head: { ref: 'feat/x', sha: 'abc' }, user: { login: 'agora-contributor[bot]' }, mergeable_state: 'blocked' } },
      'GET /repos/o/r/pulls/7/reviews?per_page=100': { status: 200, body: [{ state: 'APPROVED', commit_id: 'old' }, { state: 'COMMENTED', commit_id: 'abc' }] },
      'PUT /repos/o/r/pulls/7/merge': { status: 405, body: { message: 'Repository rule violations found\n\nCannot update this protected ref.\n' } },
      'GET /repos/o/r/pulls/8': { status: 404, body: { message: 'Not Found' } },
    }
    const github = new OperatorGitHub({
      signer: signer(),
      address: '10.244.0.9',
      request: async (input) => {
        asked.push({ method: input.method ?? 'GET', path: input.path, ...(input.body === undefined ? {} : { body: input.body }), token: input.token })
        const a = answers[`${input.method ?? 'GET'} ${input.path}`] ?? { status: 500, body: {} }
        return { status: a.status, body: JSON.stringify(a.body) }
      },
    })
    const read = await github.state('o/r', 7)
    assert.equal(read?.state, 'review', 'an approval of another commit does not count')
    assert.deepEqual(read?.pull, { number: 7, title: 'Add x', url: 'https://github.com/o/r/pull/7', open: true, merged: false, draft: false, base: 'main', head: 'feat/x', sha: 'abc', author: 'agora-contributor[bot]', mergeableState: 'blocked', mergeSha: '' })
    assert.equal(await github.pull('o/r', 8), null)
    assert.deepEqual(await github.merge('o/r', 7, 'abc'), { merged: false, reason: 'Repository rule violations found' })
    assert.deepEqual(JSON.parse(asked.at(-1)!.body!), { sha: 'abc', merge_method: 'squash' })
    answers['PUT /repos/o/r/pulls/7/merge'] = { status: 200, body: { merged: true, sha: 'def', message: 'Pull Request successfully merged' } }
    assert.deepEqual(await github.merge('o/r', 7, 'abc'), { merged: true, sha: 'def' })
    // One token for the reads and merges within its life, signed for the merge profile alone.
    assert.equal(new Set(asked.map((a) => a.token)).size, 1)
    assert.ok(claims(asked[0]!.token).grants.every((g) => g.identity === 'operator'))
  })
})

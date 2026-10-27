// Profiles compiled into grants, and the JWT that carries them (docs/specs/credentials.md, "The gateway").
// The regexes only use what RE2 (the gateway's CEL `matches`) and JavaScript share.
import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { BASE_PROFILES, baseProfiles, compileProfile, compileProfiles, GrantSigner, offeredProfiles, offers, type Grant } from '../src/index.ts'

/** What the rule of the gateway's routes with a credential decides, replayed in JavaScript. */
function allowed(grants: readonly Grant[], host: string, method: string, pathAndQuery: string): boolean {
  return grants.some((g) => g.host === host && (g.path === undefined || new RegExp(g.path).test(pathAndQuery)) && (g.methods === undefined || g.methods.includes(method)))
}

/** The same for the `internet` route, which takes every host without a route of its own: a grant on `*`. */
function allowedOnline(grants: readonly Grant[], method: string, pathAndQuery: string): boolean {
  return grants.some((g) => g.host === '*' && (g.path === undefined || new RegExp(g.path).test(pathAndQuery)) && (g.methods === undefined || g.methods.includes(method)))
}

/** A read, as GitHub's public routes take it: GET and HEAD, and on github.com git-upload-pack's POST, never git-receive-pack. */
function readsGitHub(host: string, method: string, pathAndQuery: string): boolean {
  if (host === 'api.github.com') return ['GET', 'HEAD'].includes(method)
  if (host !== 'github.com') return false
  return (['GET', 'HEAD'].includes(method) && !/git-receive-pack/.test(pathAndQuery)) || (method === 'POST' && /^\/[^/?]+\/[^/?]+\/git-upload-pack$/.test(pathAndQuery))
}

/** What the gateway decides on GitHub: a request a grant covers takes the routes with a grant, the rest the public ones. */
function allowedOnGitHub(grants: readonly Grant[], host: string, method: string, pathAndQuery: string): boolean {
  return allowed(grants, host, method, pathAndQuery) || (allowedOnline(grants, method, pathAndQuery) && readsGitHub(host, method, pathAndQuery))
}

/**
 * What the `previews` route decides, replayed: hostnames `*.preview.bretagne.dev`, and its rule — some grant with a
 * `hostPattern` the request's host matches, then path and method as on the other routes.
 */
function allowedOnPreviews(grants: readonly Grant[], host: string, method: string, pathAndQuery: string): boolean {
  if (!host.endsWith('.preview.bretagne.dev')) return false
  return grants.some((g) => g.hostPattern !== undefined && new RegExp(g.hostPattern).test(host) && (g.path === undefined || new RegExp(g.path).test(pathAndQuery)) && (g.methods === undefined || g.methods.includes(method)))
}

describe('profiles', () => {
  it('anthropic opens the whole API host', () => {
    assert.deepEqual(compileProfile('anthropic'), [{ host: 'api.anthropic.com' }])
  })

  it('chatgpt opens codex and account paths on chatgpt.com, never the conversations', () => {
    const grants = compileProfile('chatgpt')
    const cases: [string, string, string, boolean][] = [
      ['chatgpt.com', 'POST', '/backend-api/codex/responses', true],
      ['chatgpt.com', 'GET', '/backend-api/codex/models?client_version=0.159.3', true],
      ['chatgpt.com', 'GET', '/backend-api/wham/accounts/check', true],
      ['chatgpt.com', 'GET', '/backend-api/codex', true],
      ['chatgpt.com', 'GET', '/backend-api/conversations?offset=0', false],
      ['chatgpt.com', 'GET', '/backend-api/codexx/responses', false],
      ['chatgpt.com', 'GET', '/backend-api/me', false],
      ['chatgpt.com', 'GET', '/', false],
      ['auth.openai.com', 'POST', '/oauth/token', false],
      ['api.openai.com', 'POST', '/v1/responses', false],
    ]
    for (const [host, method, path, expected] of cases) assert.equal(allowed(grants, host, method, path), expected, `${method} ${host}${path}`)
  })

  it('zai opens the whole z.ai API host, and nothing of Anthropic', () => {
    const grants = compileProfile('zai')
    assert.deepEqual(grants, [{ host: 'api.z.ai' }])
    assert.equal(allowed(grants, 'api.z.ai', 'POST', '/api/paas/v4/chat/completions'), true)
    assert.equal(allowed(grants, 'api.z.ai', 'POST', '/api/anthropic/v1/messages'), true)
    assert.equal(allowed(grants, 'api.anthropic.com', 'POST', '/v1/messages'), false)
  })

  it('internet opens every host without a route of its own, and none of those with a credential', () => {
    const grants = compileProfile('internet')
    assert.deepEqual(grants, [{ host: '*' }])
    assert.equal(allowedOnline(grants, 'GET', '/'), true)
    assert.equal(allowedOnline(grants, 'POST', '/v1/anything?x=1'), true)
    for (const [host, path] of [['api.anthropic.com', '/v1/models'], ['api.z.ai', '/api/paas/v4/models'], ['chatgpt.com', '/backend-api/codex/models'], ['api.github.com', '/repos/octo/app'], ['github.com', '/octo/app.git/info/refs?service=git-upload-pack']] as const) {
      assert.equal(allowed(grants, host, 'GET', path), false, host)
    }
    // Without it, the hosts with no route of their own stay closed, whatever else is granted.
    assert.equal(allowedOnline(compileProfiles(['anthropic', 'zai', 'chatgpt', 'github:octo/app:write']), 'GET', '/'), false)
  })

  it('internet reads GitHub as the public does, through its public routes: never a write, a push or GraphQL', () => {
    const cases: [string[], string, string, string, boolean][] = [
      [['internet'], 'api.github.com', 'GET', '/repos/octo/other', true],
      [['internet'], 'api.github.com', 'HEAD', '/repos/octo/other/contents/README.md?ref=main', true],
      [['internet'], 'api.github.com', 'GET', '/search/code?q=repo:octo/other+x', true],
      [['internet'], 'github.com', 'GET', '/octo/other.git/info/refs?service=git-upload-pack', true],
      [['internet'], 'github.com', 'POST', '/octo/other.git/git-upload-pack', true],
      [['internet'], 'github.com', 'GET', '/octo/other.git/info/refs?service=git-receive-pack', false],
      [['internet'], 'github.com', 'POST', '/octo/other.git/git-receive-pack', false],
      [['internet'], 'api.github.com', 'POST', '/repos/octo/other/issues', false],
      [['internet'], 'api.github.com', 'PATCH', '/repos/octo/other', false],
      [['internet'], 'api.github.com', 'DELETE', '/repos/octo/other/git/refs/heads/main', false],
      [['internet'], 'api.github.com', 'POST', '/graphql', false],
      // A repository granted read: its writes stay closed, the Internet adds none.
      [['internet', 'github:octo/app:read'], 'api.github.com', 'PUT', '/repos/octo/app/contents/a.txt', false],
      [['internet', 'github:octo/app:read'], 'github.com', 'GET', '/octo/app.git/info/refs?service=git-receive-pack', false],
      [['internet', 'github:octo/app:write'], 'github.com', 'POST', '/octo/app.git/git-receive-pack', true],
      // Without the Internet, only what is granted.
      [['github:octo/app:read'], 'api.github.com', 'GET', '/repos/octo/other', false],
      [['anthropic'], 'github.com', 'GET', '/octo/other.git/info/refs?service=git-upload-pack', false],
    ]
    for (const [profiles, host, method, path, expected] of cases) {
      assert.equal(allowedOnGitHub(compileProfiles(profiles), host, method, path), expected, `${profiles.join(',')}: ${method} ${host}${path}`)
    }
  })

  it('composes write on one repo and read on another of the same host, without mixing them', () => {
    const grants = compileProfiles(['anthropic', 'github:octo/app:write', 'github:octo/docs.site:read'])
    const cases: [string, string, string, boolean][] = [
      ['api.github.com', 'GET', '/repos/octo/app', true],
      ['api.github.com', 'PUT', '/repos/octo/app/contents/a.txt', true],
      ['api.github.com', 'GET', '/repos/octo/docs.site/contents/README.md?ref=main', true],
      ['api.github.com', 'PUT', '/repos/octo/docs.site/contents/a.txt', false],
      ['api.github.com', 'GET', '/repos/octo/docsXsite', false],
      ['api.github.com', 'GET', '/repos/octo/app2', false],
      ['api.github.com', 'GET', '/repos/octo/other', false],
      ['api.github.com', 'POST', '/graphql', false],
      ['github.com', 'GET', '/octo/docs.site.git/info/refs?service=git-upload-pack', true],
      ['github.com', 'POST', '/octo/docs.site.git/git-upload-pack', true],
      ['github.com', 'GET', '/octo/docs.site.git/info/refs?service=git-receive-pack', false],
      ['github.com', 'POST', '/octo/docs.site.git/git-receive-pack', false],
      ['github.com', 'GET', '/octo/app.git/info/refs?service=git-receive-pack', true],
      ['github.com', 'POST', '/octo/app.git/git-receive-pack', true],
      ['api.anthropic.com', 'POST', '/v1/messages', true],
      ['api.openai.com', 'POST', '/v1/responses', false],
      ['api.z.ai', 'POST', '/api/paas/v4/chat/completions', false],
    ]
    for (const [host, method, path, expected] of cases) assert.equal(allowed(grants, host, method, path), expected, `${method} ${host}${path}`)
  })

  it('C55 previews opens the hosts pr-<n>-<app>.preview.bretagne.dev and nothing else; it is not a base profile', () => {
    const grants = compileProfile('previews')
    const cases: [string, boolean][] = [
      ['pr-42-rss.preview.bretagne.dev', true],
      ['pr-7-preview-demo.preview.bretagne.dev', true],
      ['pr-1234-a.preview.bretagne.dev', true],
      // Neighbours: another label shape, a second label, another zone, a suffix, a lookalike.
      ['preview.bretagne.dev', false],
      ['x.preview.bretagne.dev', false],
      ['pr-42.preview.bretagne.dev', false],
      ['pr-0-rss.preview.bretagne.dev', false],
      ['pr-42-rss-.preview.bretagne.dev', false],
      ['pr-42-RSS.preview.bretagne.dev', false],
      ['a.b.preview.bretagne.dev', false],
      ['pr-42-rss.x.preview.bretagne.dev', false],
      ['x.pr-42-rss.preview.bretagne.dev', false],
      ['x.bretagne.dev', false],
      ['vault.bretagne.dev', false],
      ['preview.bretagne.dev.evil.com', false],
      ['pr-42-rss.preview.bretagne.dev.evil.com', false],
      ['pr-42-rss.preview-bretagne.dev', false],
      ['pr-42-rss.preview.bretagne.dev:8443', false],
    ]
    for (const [host, expected] of cases) {
      assert.equal(allowedOnPreviews(grants, host, 'GET', '/'), expected, host)
      // Every method and path of a covered host.
      if (expected) for (const method of ['POST', 'PUT', 'DELETE']) assert.equal(allowedOnPreviews(grants, host, method, '/api/items?x=1'), true, `${method} ${host}`)
      // No other route's rule covers it: its `host` is the wildcard, which no request's host equals.
      assert.equal(allowed(grants, host, 'GET', '/'), false, host)
    }
    assert.equal(allowedOnline(grants, 'GET', '/'), false)
    assert.equal(BASE_PROFILES.has('previews'), false)
    assert.deepEqual(baseProfiles('anthropic,previews'), { profiles: [], refused: 'previews' })
    // Nothing else opens a preview: the Internet's grant has no pattern.
    assert.equal(allowedOnPreviews(compileProfiles(['anthropic', 'internet', 'github:octo/app:write']), 'pr-42-rss.preview.bretagne.dev', 'GET', '/'), false)
    for (const profile of ['preview', 'previews:read', 'previews:pr-42-rss']) assert.throws(() => compileProfile(profile), /unknown profile/, profile)
  })

  it('refuses what it does not know, and names that could escape the pattern', () => {
    for (const profile of ['github:octo/app:admin', 'github:octo:read', 'github:octo/..:read', 'github:octo/a b:read', 'openai', '']) {
      assert.throws(() => compileProfile(profile), /unknown profile|invalid repo/, profile)
    }
    assert.throws(() => compileProfiles([]), /no profile/)
  })
})

describe('GrantSigner', () => {
  it('signs a short EdDSA JWT the gateway can verify with Agora’s public key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const keyFile = join(mkdtempSync(join(tmpdir(), 'grants-')), 'key.pem')
    writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }))
    const signer = new GrantSigner({ proxy: 'gateway:3000', keyFile, keyId: 'k1', issuer: 'agora', audience: 'agora-gateway' })
    const credentials = await signer.mint({ label: 'agora sbx-0123456789', ttlSeconds: 600, profiles: ['anthropic'], address: '10.244.0.228' })
    assert.equal(credentials.proxy, 'gateway:3000')
    const [header, payload, signature] = credentials.token.split('.') as [string, string, string]
    assert.ok(verify(null, Buffer.from(`${header}.${payload}`), createPublicKey(publicKey.export({ format: 'pem', type: 'spki' })), Buffer.from(signature, 'base64url')))
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'EdDSA', typ: 'JWT', kid: 'k1' })
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
    assert.equal(claims.iss, 'agora')
    assert.equal(claims.aud, 'agora-gateway')
    assert.equal(claims.sub, 'agora sbx-0123456789')
    assert.deepEqual(claims.grants, [{ host: 'api.anthropic.com' }])
    // Bound to the Pod's address: the gateway takes the token from there only.
    assert.equal(claims.ip, '10.244.0.228')
    assert.equal((claims.exp as number) - (claims.iat as number), 600)
    assert.equal(credentials.expiresAt, new Date((claims.exp as number) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
    // No profile: a token with no grant, which withdraws the one before it.
    const none = await signer.mint({ label: 'x', ttlSeconds: 600, profiles: [], address: '10.244.0.228' })
    assert.deepEqual(JSON.parse(Buffer.from(none.token.split('.')[1]!, 'base64url').toString()).grants, [])
    await assert.rejects(signer.mint({ label: 'x', ttlSeconds: 10, profiles: ['anthropic'], address: '10.244.0.228' }), /out of bounds/)
    // No token without the address it is bound to.
    for (const address of ['', 'claude-code-0345a542ca56-9frmh', '10.244.0']) {
      await assert.rejects(signer.mint({ label: 'x', ttlSeconds: 600, profiles: ['anthropic'], address }), /invalid address/, address)
    }
  })

  it('reads the offered profiles, and what they let a Create or a Scope name', () => {
    assert.deepEqual(offeredProfiles(' github:o/a:write, github:o/b:read,zai,github:o/a:write,internet '), ['github:o/a:write', 'github:o/b:read', 'zai', 'internet'])
    assert.deepEqual(offeredProfiles(undefined), [])
    assert.throws(() => offeredProfiles('github:o/a:admin'), /unknown profile/)
    const offered = ['github:o/a:write', 'github:o/b:read', 'zai', 'internet']
    const cases: [string, boolean][] = [
      ['github:o/a:write', true],
      ['github:o/a:read', true],
      ['github:o/b:read', true],
      ['github:o/b:write', false],
      ['github:o/c:read', false],
      ['zai', true],
      ['internet', true],
      ['anthropic', false],
    ]
    for (const [profile, expected] of cases) assert.equal(offers(offered, profile), expected, profile)
    const keyFile = join(mkdtempSync(join(tmpdir(), 'grants-')), 'key.pem')
    assert.throws(() => new GrantSigner({ proxy: 'g:1', keyFile, keyId: 'k', issuer: 'i', audience: 'a', offered: ['dropbox'] }), /unknown profile/)
    assert.deepEqual(new GrantSigner({ proxy: 'g:1', keyFile, keyId: 'k', issuer: 'i', audience: 'a', offered }).describe().offered, offered)
  })

  it('reads a pool\'s base profiles: services only, never a repository nor the Internet', () => {
    assert.deepEqual(baseProfiles('anthropic,zai,chatgpt'), { profiles: ['anthropic', 'zai', 'chatgpt'], refused: null })
    assert.deepEqual(baseProfiles('anthropic'), { profiles: ['anthropic'], refused: null })
    assert.deepEqual(baseProfiles(' anthropic , '), { profiles: ['anthropic'], refused: null })
    assert.deepEqual(baseProfiles(undefined), { profiles: [], refused: null })
    assert.deepEqual(baseProfiles('anthropic,github:o/r:read'), { profiles: [], refused: 'github:o/r:read' })
    assert.deepEqual(baseProfiles('anthropic,internet'), { profiles: [], refused: 'internet' })
  })
})

// Profiles compiled into grants, and the JWT that carries them (docs/specs/credentials.md, "The gateway").
// The regexes only use what RE2 (the gateway's CEL `matches`) and JavaScript share.
import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { BASE_PROFILES, baseProfiles, compileProfile, compileProfiles, GrantSigner, KUBERNETES_HOST, mcpServers, offeredProfiles, offers, VAULT_READ_TOOLS, VAULT_WRITE_TOOLS, type Grant } from '../src/index.ts'

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

type McpTarget = { tool: string } | { prompt: string }

/** `mcp.tool.name` as CEL reads it: an error on a prompt or a resource, where `mcp.tool` is absent. */
function toolName(target: McpTarget): string {
  if (!('tool' in target)) throw new Error('no such key: tool')
  return target.tool
}

/** The vault route's tool rule: `(!has(g.tools) || (has(mcp.tool) && mcp.tool.name in g.tools))`. */
const TOOL_RULE = (g: Grant, target: McpTarget): boolean => g.tools === undefined || ('tool' in target && g.tools.includes(toolName(target)))
/** The same without `has(mcp.tool)`: `(!has(g.tools) || mcp.tool.name in g.tools)`, which fails on a prompt. */
const UNGUARDED_RULE = (g: Grant, target: McpTarget): boolean => g.tools === undefined || g.tools.includes(toolName(target))

/**
 * What the vault route decides for an MCP message on `POST /mcp`: its HTTP rule, the one of every route with a
 * credential; then its `mcpAuthorization` rule, `jwt.grants.exists(g, g.host == host && <tool rule>)`. `exists`
 * as agentgateway 1.6.0 runs it (measured in infra-k8s #295): the grants in the JWT's order, stopping at the first
 * that holds or at the first error, and an error refuses. The gateway filters `tools/list` and `prompts/list`
 * with the same rule.
 */
function vaultAllows(grants: readonly Grant[], host: string, target: McpTarget, rule = TOOL_RULE): boolean {
  if (!allowed(grants, host, 'POST', '/mcp')) return false
  try {
    return grants.some((g) => g.host === host && rule(g, target))
  } catch {
    return false
  }
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

  it('C41 vault:read and vault:write open the vault’s MCP endpoint on vault.bretagne.dev and nothing else; neither is a base profile', () => {
    for (const profile of ['vault:read', 'vault:write']) {
      const grants = compileProfile(profile)
      assert.deepEqual(new Set(grants.map((g) => g.host)), new Set(['vault.bretagne.dev']), profile)
      const cases: [string, string, string, boolean][] = [
        ['vault.bretagne.dev', 'POST', '/mcp', true],
        ['vault.bretagne.dev', 'GET', '/mcp', true],
        ['vault.bretagne.dev', 'DELETE', '/mcp', true],
        ['vault.bretagne.dev', 'PUT', '/mcp', false],
        ['vault.bretagne.dev', 'POST', '/mcp?x=1', false],
        ['vault.bretagne.dev', 'POST', '/mcp/other', false],
        ['vault.bretagne.dev', 'POST', '/sse', false],
        ['vault.bretagne.dev', 'GET', '/.well-known/oauth-protected-resource', false],
        ['vault.bretagne.dev', 'GET', '/health', false],
        ['id.bretagne.dev', 'POST', '/api/oidc/token', false],
        ['api.anthropic.com', 'POST', '/v1/messages', false],
        ['api.github.com', 'GET', '/repos/octo/app', false],
      ]
      for (const [host, method, path, expected] of cases) assert.equal(allowed(grants, host, method, path), expected, `${profile}: ${method} ${host}${path}`)
      // Never the Internet's: no grant on `*`.
      assert.equal(allowedOnline(grants, 'POST', '/mcp'), false, profile)
      assert.equal(BASE_PROFILES.has(profile), false, profile)
      assert.deepEqual(baseProfiles(`anthropic,${profile}`), { profiles: [], refused: profile })
    }
    // The Internet opens nothing of the vault: the route compares hosts.
    assert.equal(vaultAllows(compileProfiles(['internet']), 'vault.bretagne.dev', { tool: 'read_note' }), false)
    for (const profile of ['vault', 'vault:admin', 'vault:read:write', 'vault:']) assert.throws(() => compileProfile(profile), /unknown profile/, profile)
  })

  it('C42 a vault:read grant covers a call of a read tool, never of a write tool; vault:write covers both', () => {
    const read = compileProfile('vault:read')
    const write = compileProfile('vault:write')
    const host = 'vault.bretagne.dev'
    for (const tool of VAULT_READ_TOOLS) {
      assert.equal(vaultAllows(read, host, { tool }), true, `read: ${tool}`)
      assert.equal(vaultAllows(write, host, { tool }), true, `write: ${tool}`)
    }
    for (const tool of VAULT_WRITE_TOOLS) {
      assert.equal(vaultAllows(read, host, { tool }), false, `read: ${tool}`)
      assert.equal(vaultAllows(write, host, { tool }), true, `write: ${tool}`)
    }
    // The prompt clip-to-vault, which leads to clip_url: write only.
    assert.equal(vaultAllows(read, host, { prompt: 'clip-to-vault' }), false)
    assert.equal(vaultAllows(write, host, { prompt: 'clip-to-vault' }), true)
    // Read and write together: write, as with GitHub.
    assert.equal(vaultAllows(compileProfiles(['vault:read', 'vault:write']), host, { tool: 'delete_note' }), true)
    // A tool the server would add: closed to read, open to write, which is the whole server.
    assert.equal(vaultAllows(read, host, { tool: 'run_command' }), false)
    assert.equal(vaultAllows(write, host, { tool: 'run_command' }), true)
    // Another host: nothing.
    assert.equal(vaultAllows(write, 'vault.example', { tool: 'read_note' }), false)
    // tools/list, filtered by the same rule.
    const listed = [...VAULT_READ_TOOLS, ...VAULT_WRITE_TOOLS]
    assert.deepEqual(listed.filter((tool) => vaultAllows(read, host, { tool })), [...VAULT_READ_TOOLS])
    assert.deepEqual(listed.filter((tool) => vaultAllows(write, host, { tool })), listed)
    // The two lists are the server's twelve tools, each in one list; no other profile names a tool.
    assert.equal(new Set(listed).size, 12)
    assert.ok(compileProfiles(['anthropic', 'zai', 'chatgpt', 'internet', 'github:octo/app:write']).every((g) => g.tools === undefined))
  })

  it('C46 vault:read and vault:write in one token, in either order: the prompt, a write tool and a read tool let through', () => {
    const host = 'vault.bretagne.dev'
    for (const order of [['vault:read', 'vault:write'], ['vault:write', 'vault:read']]) {
      const grants = compileProfiles(order)
      for (const target of [{ prompt: 'clip-to-vault' }, { tool: 'clip_url' }, { tool: 'delete_note' }, { tool: 'read_note' }]) {
        assert.equal(vaultAllows(grants, host, target), true, `${order.join(',')}: ${JSON.stringify(target)}`)
      }
      // Read alone still refuses the prompt and the write tools.
      assert.equal(vaultAllows(compileProfiles([order.find((p) => p === 'vault:read')!]), host, { prompt: 'clip-to-vault' }), false)
    }
    // Control: without has(mcp.tool), the read grant first fails on the prompt and refuses it, as measured on the
    // gateway; the write grant first lets it through. The replay tells the two rules apart.
    assert.equal(vaultAllows(compileProfiles(['vault:read', 'vault:write']), host, { prompt: 'clip-to-vault' }, UNGUARDED_RULE), false)
    assert.equal(vaultAllows(compileProfiles(['vault:write', 'vault:read']), host, { prompt: 'clip-to-vault' }, UNGUARDED_RULE), true)
  })

  it('opens the vault’s MCP server for session/new once, with no secret, and none without a vault profile', () => {
    const vault = { type: 'http', name: 'vault', url: 'https://vault.bretagne.dev/mcp', headers: [] }
    assert.deepEqual(mcpServers(['anthropic', 'vault:read']), [vault])
    assert.deepEqual(mcpServers(['vault:write']), [vault])
    assert.deepEqual(mcpServers(['vault:read', 'vault:write']), [vault])
    assert.deepEqual(mcpServers(['anthropic', 'internet', 'github:octo/app:write']), [])
    assert.deepEqual(mcpServers([]), [])
  })

  it('C49 kubernetes:read opens GET and HEAD on the API of kubernetes.agora.internal, nothing else; it is not a base profile', () => {
    const grants = compileProfile('kubernetes:read')
    assert.equal(KUBERNETES_HOST, 'kubernetes.agora.internal')
    assert.deepEqual(new Set(grants.map((g) => g.host)), new Set([KUBERNETES_HOST]))
    const h = KUBERNETES_HOST
    const cases: [string, string, string, boolean][] = [
      [h, 'GET', '/api', true],
      [h, 'GET', '/apis', true],
      [h, 'GET', '/version?timeout=32s', true],
      [h, 'GET', '/openapi/v3', true],
      [h, 'GET', '/api/v1/namespaces/agora/pods?limit=500', true],
      [h, 'HEAD', '/api/v1/nodes', true],
      // A watch is a GET.
      [h, 'GET', '/api/v1/namespaces/agora/pods?watch=true&resourceVersion=12', true],
      [h, 'GET', '/apis/apps/v1/namespaces/agora/deployments/server', true],
      [h, 'POST', '/api/v1/namespaces/agora/pods', false],
      [h, 'PUT', '/api/v1/namespaces/agora/configmaps/c', false],
      [h, 'PATCH', '/apis/apps/v1/namespaces/agora/deployments/server', false],
      [h, 'DELETE', '/api/v1/namespaces/agora/pods/p', false],
      [h, 'POST', '/api/v1/namespaces/agora/pods/p/exec?command=sh', false],
      [h, 'POST', '/api/v1/namespaces/agora/serviceaccounts/default/token', false],
      [h, 'OPTIONS', '/api', false],
      // The API's paths only: not the server's health or logs, nor the root.
      [h, 'GET', '/', false],
      [h, 'GET', '/healthz', false],
      [h, 'GET', '/logs/kube-apiserver.log', false],
      [h, 'GET', '/apiz', false],
      ['kubernetes.default.svc', 'GET', '/api', false],
      ['api.github.com', 'GET', '/repos/octo/app', false],
    ]
    for (const [host, method, path, expected] of cases) assert.equal(allowed(grants, host, method, path), expected, `${method} ${host}${path}`)
    assert.equal(allowedOnline(grants, 'GET', '/api'), false)
    // Not a base profile: a pool declaring it gets no warm token.
    assert.equal(BASE_PROFILES.has('kubernetes:read'), false)
    assert.deepEqual(baseProfiles('anthropic,kubernetes:read'), { profiles: [], refused: 'kubernetes:read' })
    // The Internet never opens it: the route compares hosts.
    assert.equal(allowed(compileProfile('internet'), h, 'GET', '/api'), false)
    for (const profile of ['kubernetes', 'kubernetes:write', 'kubernetes:admin', 'kubernetes:read:all']) assert.throws(() => compileProfile(profile), /unknown profile/, profile)
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

  it('C47 vault:write offered lets a Create or a Scope name vault:read, as a repository’s write does; vault:read offered, never vault:write', () => {
    const cases: [string[], string, boolean][] = [
      [['vault:write'], 'vault:write', true],
      [['vault:write'], 'vault:read', true],
      [['vault:read'], 'vault:read', true],
      [['vault:read'], 'vault:write', false],
      [['github:o/a:write'], 'vault:read', false],
      [['anthropic'], 'vault:read', false],
    ]
    for (const [offered, profile, expected] of cases) assert.equal(offers(offered, profile), expected, `${offered.join(',')}: ${profile}`)
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

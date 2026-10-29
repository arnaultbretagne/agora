// Composition by policy (docs/specs/credentials.md, "The gateway"): an execution's rights are a set of
// profiles, compiled here into grants — host, anchored regex on path and query, methods — and signed
// by Agora into a short JWT. The gateway checks each request against those grants, then sets the
// broad credential it holds for the host. No entity per combination: the set lives in the JWT.
import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import type { Credentials } from '@agora/harness-bridge/outbound'
import { LIMIT_ENDPOINTS } from './limits.ts'

export interface Grant {
  readonly host: string
  /** Anchored regex on `request.pathAndQuery`; every path when absent. */
  readonly path?: string
  /** Every method when absent. */
  readonly methods?: readonly string[]
  /**
   * The MCP tools a call may name, on a route whose backend is an MCP server: there every message is a `POST`
   * to one path, so the gateway checks the tool in the protocol (`mcpAuthorization`). Every tool, prompt and
   * resource of the server when absent; only these tools, and no prompt or resource, when present.
   */
  readonly tools?: readonly string[]
}

/** An MCP server a profile opens, as `session/new` names it: reached through the gateway like any host, with no secret. */
export interface McpServer {
  readonly type: 'http'
  readonly name: string
  readonly url: string
  readonly headers: readonly { readonly name: string; readonly value: string }[]
}

export class ProfileRefused extends Error {
  readonly status = 400
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/
const READ = ['GET', 'HEAD'] as const

/** The Obsidian vault's MCP server (obsidian-mcp 0.4.0): the tools that only read it, and those that change it. */
const VAULT_HOST = 'vault.bretagne.dev'
export const VAULT_READ_TOOLS: readonly string[] = ['read_note', 'search_content', 'search_properties', 'get_backlinks', 'list_properties', 'get_property_values']
// clip_url fetches a page and writes it into the vault as a note; update_schema writes the schema overlay.
export const VAULT_WRITE_TOOLS: readonly string[] = ['create_note', 'update_note', 'delete_note', 'move_note', 'update_schema', 'clip_url']
const VAULT: McpServer = { type: 'http', name: 'vault', url: `https://${VAULT_HOST}/mcp`, headers: [] }
/**
 * The name the sandbox gives the cluster's API server: it resolves nowhere (`.internal` is reserved for private
 * use), and only the gateway's `kubernetes` route knows it, which sends it to the API server.
 */
export const KUBERNETES_HOST = 'kubernetes.agora.internal'

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compiles one profile. The catalogue is here, in code, reviewed like code. */
export function compileProfile(profile: string): Grant[] {
  if (profile === 'anthropic') return [{ host: 'api.anthropic.com' }]
  // z.ai (GLM): its OpenAI- and Anthropic-compatible APIs share the host.
  if (profile === 'zai') return [{ host: 'api.z.ai' }]
  // ChatGPT, for codex: only its backend's codex and account paths — the session reaches the whole
  // account, conversations included.
  if (profile === 'chatgpt') return [{ host: 'chatgpt.com', path: '^/backend-api/(codex|wham)(/[^?]*)?(\\?.*)?$' }]
  // The Internet: `*` stands for any host the gateway has no route of its own for, reached with no
  // credential. The routes with a credential compare the grant's host with the request's, so this
  // grant never opens them; GitHub's public routes read `*` too, for what anyone may read there.
  if (profile === 'internet') return [{ host: '*' }]
  // The vault: its MCP endpoint only — POST for every message, GET for the server's stream, DELETE to end the
  // session. Read names its tools, which leaves out the others, the prompt included; write names none: the whole server.
  if (profile === 'vault:read') return [{ host: VAULT_HOST, path: '^/mcp$', methods: ['GET', 'POST', 'DELETE'], tools: [...VAULT_READ_TOOLS] }]
  if (profile === 'vault:write') return [{ host: VAULT_HOST, path: '^/mcp$', methods: ['GET', 'POST', 'DELETE'] }]
  // The cluster, read: GET and HEAD on the API's own paths — a watch is a GET. What may be read is the
  // credential's RBAC: no Secret, no exec, attach, port-forward or proxy, no token (docs/specs/credentials.md).
  if (profile === 'kubernetes:read') return [{ host: KUBERNETES_HOST, path: '^/(api|apis|openapi|version)(/[^?]*)?(\\?.*)?$', methods: [...READ] }]
  const github = /^github:([^/:]+)\/([^/:]+):(read|write)$/.exec(profile)
  if (github !== null) {
    const [, owner = '', repo = '', level] = github
    if (!NAME.test(owner) || !NAME.test(repo) || repo === '.' || repo === '..') throw new ProfileRefused(`invalid repo: ${owner}/${repo}`)
    const rest = `^/repos/${escape(owner)}/${escape(repo)}(/[^?]*)?(\\?.*)?$`
    // git smart HTTP: a clone POSTs too (git-upload-pack); writing is git-receive-pack.
    const services = level === 'write' ? '(upload|receive)' : 'upload'
    const git = `^/${escape(owner)}/${escape(repo)}(\\.git)?/(info/refs\\?service=git-${services}-pack|git-${services}-pack)$`
    return level === 'write'
      ? [{ host: 'api.github.com', path: rest }, { host: 'github.com', path: git }]
      : [{ host: 'api.github.com', path: rest, methods: [...READ] }, { host: 'github.com', path: git }]
  }
  throw new ProfileRefused(`unknown profile: ${profile}`)
}

/**
 * The profiles Agora gives itself, never an execution: unknown to `compileProfile`, so a Create or a
 * Scope naming one is refused. `limits` reads each account's usage endpoint (limits.ts), GET only.
 */
const OWN_PROFILES: Readonly<Record<string, () => Grant[]>> = {
  limits: () => Object.values(LIMIT_ENDPOINTS).map((e) => ({ host: e.host, path: `^${escape(e.path)}$`, methods: ['GET'] })),
}

/** What a pool may declare for its warm Pods (docs/specs/credentials.md, "Base profiles"): a service, never a repository nor the Internet. */
export const BASE_PROFILES: ReadonlySet<string> = new Set(['anthropic', 'zai', 'chatgpt'])

/** The annotation on a SandboxWarmPool that declares its base profiles, separated by commas. */
export const BASE_PROFILES_ANNOTATION = 'agora.bretagne.dev/base-profiles'

/** A pool's annotation, read: its base profiles, or none and the first profile refused. */
export function baseProfiles(annotation: string | undefined): { profiles: string[]; refused: string | null } {
  const profiles = (annotation ?? '')
    .split(',')
    .map((profile) => profile.trim())
    .filter((profile) => profile !== '')
  const refused = profiles.find((profile) => !BASE_PROFILES.has(profile)) ?? null
  return refused === null ? { profiles, refused: null } : { profiles: [], refused }
}

/** The MCP servers an execution's profiles open, for its `session/new` (docs/specs/credentials.md, "MCP servers"): each once. */
export function mcpServers(profiles: readonly string[]): McpServer[] {
  return profiles.some((profile) => profile === 'vault:read' || profile === 'vault:write') ? [VAULT] : []
}

export function compileProfiles(profiles: readonly string[]): Grant[] {
  if (profiles.length === 0) throw new ProfileRefused('no profile')
  return profiles.flatMap(compileProfile)
}

/** `OFFERED_PROFILES`, read (docs/specs/credentials.md, "Offered profiles"): each profile once, all known to the catalogue. */
export function offeredProfiles(value: string | undefined): string[] {
  const profiles = [...new Set((value ?? '').split(',').map((p) => p.trim()).filter((p) => p !== ''))]
  for (const profile of profiles) compileProfile(profile)
  return profiles
}

/** Whether a profile may be named, given those offered: itself, or the read of a repository or of the vault under its write. */
export function offers(offered: readonly string[], profile: string): boolean {
  if (offered.includes(profile)) return true
  const read = /^(github:[^:]+|vault):read$/.exec(profile)
  return read !== null && offered.includes(`${read[1]!}:write`)
}

export interface GrantSignerOptions {
  /** The gateway's CONNECT listener as the bridge reaches it, `host:port`. */
  readonly proxy: string
  readonly keyFile: string
  readonly keyId: string
  readonly issuer: string
  readonly audience: string
  /** What an execution may be given beyond its pool's base profiles; any profile when empty. */
  readonly offered?: readonly string[]
}

export class GrantSigner {
  private readonly options: GrantSignerOptions
  private key: KeyObject | null = null

  constructor(options: GrantSignerOptions) {
    for (const profile of options.offered ?? []) compileProfile(profile)
    this.options = options
  }

  get offered(): readonly string[] {
    return this.options.offered ?? []
  }

  describe(): { proxy: string; profiles: string[]; base: string[]; offered: string[] } {
    return {
      proxy: this.options.proxy,
      profiles: ['anthropic', 'zai', 'chatgpt', 'internet', 'github:<owner>/<repo>:read', 'github:<owner>/<repo>:write', 'vault:read', 'vault:write', 'kubernetes:read'],
      base: [...BASE_PROFILES],
      offered: [...this.offered],
    }
  }

  /**
   * A token for these profiles; for none, a token with no grant, which withdraws the one before it.
   * `address` is the Pod's, as Kubernetes records it: the gateway takes the token only from there, so a
   * token read out of the Pod is worth nothing anywhere else.
   */
  async mint(input: { label: string; ttlSeconds: number; profiles?: readonly string[]; address: string }): Promise<Credentials> {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 24 * 3600) throw new ProfileRefused('duration out of bounds: 60 to 86,400 s')
    if (isIP(input.address) === 0) throw new ProfileRefused(`invalid address: ${input.address}`)
    const grants = (input.profiles ?? []).flatMap((profile) => OWN_PROFILES[profile]?.() ?? compileProfile(profile))
    this.key ??= createPrivateKey(await readFile(this.options.keyFile))
    const now = Math.floor(Date.now() / 1000)
    const exp = now + input.ttlSeconds
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
    const header = { alg: 'EdDSA', typ: 'JWT', kid: this.options.keyId }
    const payload = { iss: this.options.issuer, aud: this.options.audience, sub: input.label, jti: randomUUID(), iat: now, exp, ip: input.address, profiles: input.profiles, grants }
    const data = `${encode(header)}.${encode(payload)}`
    const token = `${data}.${sign(null, Buffer.from(data), this.key).toString('base64url')}`
    return { proxy: this.options.proxy, token, expiresAt: new Date(exp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') }
  }
}

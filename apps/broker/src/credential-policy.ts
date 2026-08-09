import type { CapabilityFact } from '@agora/equipment-policy'

export const CREDENTIAL_SET_VERSION = 'credentials-v1'

/**
 * ADR 0015, credential half: OneCLI is a **credential firewall**. It decides which provider
 * credential is injected for which Agent, and nothing about which hosts an Agent may reach (that
 * is `route-policy.ts` + the relay). This file compiles, per Session, exactly which OneCLI
 * credentials that Session's dedicated Agent may have — the input to
 * `OneCliControlAdapter.syncCredentialGrants`.
 *
 * Why this replaced `secretMode` (measured, not assumed): before P13 every live OneCLI Agent ran
 * `secretMode: all` and every published rule carried `identities: []`, so ANY Session's Agent
 * could inject ANY project secret — `ensureSelectiveAgent` could not actually make an Agent
 * selective, because 1.43.3's `CreateAgentInput` has no `secretMode` and selectivity was a
 * separate `PATCH /v1/agents/{id}/secret-mode`. On ≥1.44 that PATCH answers `410 Gone` ("agents
 * are always selective now") and grants are the only writer. Verified live on a staging 1.45.0
 * instance, 2026-08-09: a freshly created Agent reports `{mode:"selective",secrets:[],
 * connections:[]}` — zero access, fail-closed by construction — attaching one secret grant flips
 * exactly that secret to `status:"usable"` while a second Agent's set stays empty, and detaching
 * returns it to empty. Isolation is therefore correct by construction now, per Agent, with no
 * shared publish anywhere.
 *
 * Credentials are named here by OneCLI **type/provider**, never by instance id or display name:
 * `secretId`/`connectionId` are per-instance UUIDs the adapter resolves at runtime
 * (`GET /v1/secrets`, `GET /v1/connections`), so nothing here breaks when the operator re-creates
 * a secret.
 */

export interface PinnedAgentCredentials {
  readonly agentId: string
  /** OneCLI secret `type` values (`anthropic` | `openai` | `generic`), never instance ids. */
  readonly secretTypes: readonly string[]
}

/**
 * docs/specs/10 "Agent invocation": "the right to invoke the selected Agent/provider is resolved
 * automatically from `agent_id`, runtime definition and principal policy. It is not user-visible
 * equipment." — so the Agent's own provider credential is pinned per Agent here, exactly like its
 * pinned route set, and never derives from an equipment request.
 *
 * `fake-agent`/`fake-agent-b` are apps/web's fake driver identities (P05/P07). They have no
 * provider and therefore no credential — an empty list is the honest, reviewed answer, not a
 * placeholder: a Session on a fake Agent legitimately ends with an Agent that can inject nothing.
 */
export const PINNED_AGENT_CREDENTIALS: readonly PinnedAgentCredentials[] = [
  { agentId: 'claude-code', secretTypes: ['anthropic'] },
  { agentId: 'codex', secretTypes: ['openai'] },
  { agentId: 'fake-agent', secretTypes: [] },
  { agentId: 'fake-agent-b', secretTypes: [] },
]

export interface CapabilityConnectionGrant {
  /** OneCLI connection `provider` (e.g. `github-app`), never a connection instance id. */
  readonly provider: string
  /** Tool ids from OneCLI's own permission catalogue for that provider. Unnamed tools are blocked. */
  readonly allowedToolIds: readonly string[]
}

/**
 * Equipment capabilities that map to an OneCLI-held credential, keyed by
 * `capabilityId/accessLevel` — same reviewed-per-access-level discipline as
 * `CAPABILITY_ROUTE_HOSTS`, so `propose` can never silently inherit `read`'s grant or vice versa.
 *
 * `vault` maps to nothing: it is served by Broker's own credential-free MCP shim, never by an
 * OneCLI-injected credential.
 *
 * The `github-app` tool ids are OneCLI's own catalogue ids, read at the 1.45.0 image (2026-08-09),
 * not invented here — `PUT …/grants/connections/{id}` answers `422 Unknown tool id(s)` for
 * anything outside that catalogue, so a typo fails closed at issue rather than silently granting
 * nothing. `read` is the catalogue's whole `read` group; `propose` is `read` plus the write tools
 * that create a proposal (`git_push`, `create_pull`, `create_comment`, `create_issue`,
 * `graphql_mutation`) and deliberately NOT `delete_branch` — proposing a change is not destroying
 * a ref, and a tool named by neither list is blocked.
 *
 * Nothing is ever placed in OneCLI's `ask` (require-approval) list: an `ask` tool suspends the
 * request until a human approves it through OneCLI's own approval channel, which a headless
 * Session Runtime has no path to — the Agent would hang rather than be denied. It also requires an
 * entitlement check OneCLI Community does not satisfy. Access this program cannot approve is
 * therefore expressed as "not granted", which fails closed.
 */
const CAPABILITY_CONNECTION_GRANTS: Readonly<Record<string, readonly CapabilityConnectionGrant[]>> = {
  'vault/read': [],
  'vault/read-write': [],
  'github/read': [
    {
      provider: 'github-app',
      allowedToolIds: ['git_clone', 'get_repo', 'list_repos', 'list_pulls', 'list_issues', 'graphql_query', 'read_raw_content'],
    },
  ],
  'github/propose': [
    {
      provider: 'github-app',
      allowedToolIds: [
        'git_clone',
        'get_repo',
        'list_repos',
        'list_pulls',
        'list_issues',
        'graphql_query',
        'read_raw_content',
        'git_push',
        'create_pull',
        'create_comment',
        'create_issue',
        'graphql_mutation',
      ],
    },
  ],
}

export class CredentialPolicyError extends Error {
  constructor(
    readonly code: 'unknown_pinned_agent' | 'unknown_capability_credential_mapping',
    message: string,
  ) {
    super(message)
    this.name = 'CredentialPolicyError'
  }
}

/** Exactly the credentials one Session's OneCLI Agent may hold. Everything absent is blocked. */
export interface DesiredCredentialGrants {
  readonly credentialSetVersion: string
  /** OneCLI secret `type`s, deduplicated and sorted. */
  readonly secretTypes: readonly string[]
  /** One entry per OneCLI connection provider, tool ids deduplicated and sorted. */
  readonly connections: readonly CapabilityConnectionGrant[]
}

export interface CredentialPolicySubject {
  readonly agentId: string
  readonly capabilities: readonly CapabilityFact[]
}

function pinnedSecretTypesFor(agentId: string): readonly string[] {
  const pinned = PINNED_AGENT_CREDENTIALS.find((entry) => entry.agentId === agentId)
  if (!pinned) {
    throw new CredentialPolicyError('unknown_pinned_agent', `no reviewed credential set for Agent '${agentId}' — refusing to attach an unreviewed credential`)
  }
  return pinned.secretTypes
}

function capabilityConnectionsFor(fact: CapabilityFact): readonly CapabilityConnectionGrant[] {
  const key = `${fact.capabilityId}/${fact.accessLevel}`
  const grants = CAPABILITY_CONNECTION_GRANTS[key]
  if (grants === undefined) {
    throw new CredentialPolicyError(
      'unknown_capability_credential_mapping',
      `no reviewed credential mapping for '${key}' — refusing to attach an unreviewed credential`,
    )
  }
  return grants
}

/**
 * Deterministic (sorted, deduplicated) — the same grant always compiles to the same credential set
 * regardless of capability order, so `syncCredentialGrants` can compare it against what OneCLI
 * currently holds and converge without churn.
 *
 * Two Sessions on the same Agent with the same equipment compile to the same SET of credential
 * types, which is not a leak: they are still attached to two DIFFERENT per-Session OneCLI Agents,
 * and detaching one changes nothing for the other (verified live on 1.45.0).
 */
export function compileSessionCredentialGrants(subject: CredentialPolicySubject): DesiredCredentialGrants {
  const secretTypes = new Set(pinnedSecretTypesFor(subject.agentId))
  const toolsByProvider = new Map<string, Set<string>>()

  for (const fact of subject.capabilities) {
    for (const connection of capabilityConnectionsFor(fact)) {
      const tools = toolsByProvider.get(connection.provider) ?? new Set<string>()
      for (const toolId of connection.allowedToolIds) tools.add(toolId)
      toolsByProvider.set(connection.provider, tools)
    }
  }

  return {
    credentialSetVersion: CREDENTIAL_SET_VERSION,
    secretTypes: [...secretTypes].sort(),
    connections: [...toolsByProvider.entries()]
      .map(([provider, tools]) => ({ provider, allowedToolIds: [...tools].sort() }))
      .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0)),
  }
}

// The relay's allow/deny decision (ADR 0009), factored out pure: given who is asking (resolved
// identity), what they may reach (the fresh effective projection) and where they're asking to go,
// decide once — before any upstream socket opens. Everything here is synchronous and total: no
// network, no partial state, so the one thing that actually matters (does this exact host clear
// the exact fresh projection) is trivial to exercise from every angle.
import type { EffectiveCredentialForReachability, EgressHostCatalogue } from '@agora/policy'
import { projectReachability } from '@agora/policy'

export type ConnectDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: 'unresolved_identity' | 'unbound_agent' | 'host_not_reachable' | 'credential_unavailable' }

export interface ConnectContext {
  readonly identity: { readonly workstreamId: string; readonly incarnation: string } | undefined
  readonly agentId: string | undefined
  readonly effective: readonly EffectiveCredentialForReachability[] | undefined
  readonly bearerAvailable: boolean
  readonly targetHost: string
  readonly egressHosts: EgressHostCatalogue
}

export function decideConnect(ctx: ConnectContext): ConnectDecision {
  if (ctx.identity === undefined) return { allow: false, reason: 'unresolved_identity' }
  if (ctx.agentId === undefined) return { allow: false, reason: 'unbound_agent' }
  if (ctx.effective === undefined) return { allow: false, reason: 'host_not_reachable' } // a failed read produces no set (002) — never treated as "everything"
  const allowedHosts = projectReachability(ctx.effective, ctx.egressHosts)
  if (!allowedHosts.has(ctx.targetHost)) return { allow: false, reason: 'host_not_reachable' }
  if (!ctx.bearerAvailable) return { allow: false, reason: 'credential_unavailable' }
  return { allow: true }
}

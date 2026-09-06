// The relay's reachability projection (ADR 0009 — "a fixed deterministic projection of OneCLI's
// observed effective grant set"; S7 Step 5). Never an independent allow list, never something the
// relay authorizes on its own: it only narrows which hosts a CONNECT may even reach before OneCLI's
// own gateway makes the real, credential-backed decision. A usable secret's own host (set by an
// operator when the secret was configured — the same reviewed authority as the catalogue itself)
// is trusted directly; a connection's host set comes only from the reviewed egress-hosts catalogue,
// keyed by `provider`. An unrecognized provider projects to nothing — never guessed open.
import { readFileSync } from 'node:fs'

export interface EffectiveCredentialForReachability {
  readonly kind: 'secret' | 'connection'
  readonly status: string
  readonly host?: string
  readonly provider?: string
}

export interface EgressHostCatalogue {
  hostsFor(provider: string): readonly string[]
}

export function loadEgressHostCatalogue(path: string): EgressHostCatalogue {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { hosts: Record<string, readonly string[]> }
  return { hostsFor: (provider) => parsed.hosts[provider] ?? [] }
}

/** Every host a currently-usable credential may reach. Anything not `usable` contributes nothing — organization policy already vetoed it, the relay is not a second opinion. */
export function projectReachability(effective: readonly EffectiveCredentialForReachability[], egressHosts: EgressHostCatalogue): ReadonlySet<string> {
  const hosts = new Set<string>()
  for (const credential of effective) {
    if (credential.status !== 'usable') continue
    if (credential.kind === 'secret' && credential.host !== undefined) {
      hosts.add(credential.host)
    } else if (credential.kind === 'connection' && credential.provider !== undefined) {
      for (const host of egressHosts.hostsFor(credential.provider)) hosts.add(host)
    }
  }
  return hosts
}

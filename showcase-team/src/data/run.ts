// Run 2f437cd3 of the lead/dev/sre/judge flow (2026-10-28): finish six draft PRs on agent rights.
// run-2f437cd3.json holds what the demo quotes verbatim from the lead's thread (the envelope, the
// briefs, the members' reports and answers, the judge's questions); the goal and the judge's
// verdicts were written in French and are translated here. Member transcripts are reconstructed:
// their messages are the members' own, the tool calls between them are plausible stand-ins.
import raw from './run-2f437cd3.json'

export type FeatureId =
  | 'vault-profile'
  | 'kubernetes-profile'
  | 'preview-profile'
  | 'vault-route'
  | 'kubernetes-route'
  | 'preview-route'

export type Feature = {
  id: FeatureId
  title: string
  repo: string
  base: string
  branch: string
  criteria: string[]
}

export const RUN_ID = '2f437cd3'
export const PLAN = raw.plan as {
  title: string
  why: string
  features: Feature[]
  team: { name: string; role: string; harness: string; model: string; effort: string; access: string[] }[]
}
export const FEATURES = PLAN.features
export const FEATURE_ORDER: FeatureId[] = FEATURES.map((f) => f.id)

export const LEAD = {
  name: 'lead',
  harness: 'claude-code',
  model: 'opus',
  effort: 'high',
  access: ['github:arnaultbretagne/agora:read', 'github:arnaultbretagne/infra-k8s:read', 'internet'],
}
export const JUDGE = { name: 'judge', harness: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }
export const LIMITS = [
  '100 decisions of the lead, 25 verifications',
  'A member turn lasts at most an hour',
  'Nobody merges or deploys',
]

export const member = (name: string) => {
  const m = PLAN.team.find((t) => t.name === name)
  if (!m) throw new Error(`no member ${name}`)
  return m
}

/** Where each feature lives, and the heads the run moved it through. */
export const PR: Record<FeatureId, { repo: string; n: number; branch: string; oldHead: string; head: string; run: string }> = {
  'vault-profile': { repo: 'agora', n: 161, branch: 'feat/credentials-vault', oldHead: '929f96b', head: 'ba52715', run: '40758575049' },
  'kubernetes-profile': { repo: 'agora', n: 160, branch: 'feat/credentials-kubernetes', oldHead: '2df72a3', head: 'e3ed49f', run: '40751530890' },
  'preview-profile': { repo: 'agora', n: 162, branch: 'feat/credentials-previews', oldHead: 'b887ae1', head: '2a24f3d', run: '40759614999' },
  'vault-route': { repo: 'infra-k8s', n: 301, branch: 'feat/agora-gateway-vault', oldHead: '62fdf7f', head: '5dd1350', run: '40754319352' },
  'kubernetes-route': { repo: 'infra-k8s', n: 302, branch: 'feat/agora-gateway-kubernetes', oldHead: 'e788e0c', head: '124b771', run: '40755293028' },
  'preview-route': { repo: 'infra-k8s', n: 303, branch: 'feat/agora-gateway-previews', oldHead: 'c3a3ff3', head: '755737d', run: '40756453843' },
}
export const prUrl = (f: FeatureId) => `https://github.com/arnaultbretagne/${PR[f].repo}/pull/${PR[f].n}`
export const prLabel = (f: FeatureId) => `${PR[f].repo} #${PR[f].n}`

/** The person's goal, as they gave it to the lead (translated from French). */
export const GOAL = `Finish six PRs already open as drafts, left by an earlier run on extending the agents' rights (vault MCP, Kubernetes reading, previews for the judge). Each feature continues ITS existing branch and ITS open PR, base \`main\`: create no new branch and no new PR. The work stops at PRs ready to review: green CI on the last commit, judged shippable. Nobody merges.

The six features, one per PR:
- vault-profile — arnaultbretagne/agora — branch feat/credentials-vault — PR #161 — judged shippable before main moved ahead; 21 commits behind, merges without conflict.
- kubernetes-profile — arnaultbretagne/agora — feat/credentials-kubernetes — #160 — same situation.
- preview-profile — arnaultbretagne/agora — feat/credentials-previews — #162 — IN CONFLICT with main. Last refusal: the revocation procedure. Pocket-ID 2.18.0 keeps the old secrets when a new one is created, so the old secret has to be deleted explicitly, and "disabling the client" does not exist. Fixed since, never judged again.
- vault-route — arnaultbretagne/infra-k8s — feat/agora-gateway-vault — #301 — judged shippable; 6 commits behind, no conflict.
- kubernetes-route — arnaultbretagne/infra-k8s — feat/agora-gateway-kubernetes — #302 — same situation.
- preview-route — arnaultbretagne/infra-k8s — feat/agora-gateway-previews — #303 — never judged.

For each one: bring the branch up to date with main by a merge (never a force-push) and resolve the conflicts. Then green CI on the last commit, then a verification by the judge. The acceptance criteria are the ones each PR describes: don't widen the scope, add nothing that doesn't serve finishing.

Already decided, not to be asked again:
- The proof that the system works is the end-to-end test in CI, on the real agentgateway 1.6.0 binary, against stand-ins: a fake MCP for the vault, kind for Kubernetes, oauth2-proxy for previews. No preview: agora has none, and agora-gateway is excluded from previews (ADR 0017).
- The infra PRs don't touch OFFERED_PROFILES.
- For each right, the agora PR merges before the infra PR.

Minimal team: one dev for the three agora PRs (agora write, infra-k8s read) and one sre for the three infra-k8s PRs (infra-k8s write, agora read).`

type Check = [id: string, name: string]

/** The judge's verdicts (all "pass"), check names and summaries translated from French. */
export const VERDICTS: Record<FeatureId, { checks: Check[]; summary: string }> = {
  'vault-profile': {
    checks: [
      ['C1', 'Existing PR and branch kept'],
      ['C2', 'Old head and main are ancestors of the new head'],
      ['C3', 'No conflict'],
      ['C4', 'Required checks green on the last commit'],
      ['C5', 'The vault tests actually ran'],
      ['C6', 'Diff, PR body and R21 agree'],
    ],
    summary:
      "Shippable at ba52715: no blocker found. It stays an open draft, unmerged; the required approval is still needed. Accepted residual risks: the real integration with the cluster is not verified, and C47 is limited to offers. Non-blocking: the Agora fixture keeps the historical 8080318 configuration, so the proof of the stateless mode and of rotation comes from infra #301's CI, not from R21.",
  },
  'kubernetes-profile': {
    checks: [
      ['C1', 'PR and branch kept'],
      ['C2', 'History kept, main merged in'],
      ['C3', 'No conflict'],
      ['C4', 'Checks on the last commit'],
      ['C5', 'C49–C52 ran and asserted'],
      ['C6', 'Scope and documents agree'],
      ['X1', 'Matches infra-k8s #302'],
    ],
    summary:
      'Shippable at the approved level of proof, no blocker. Still a draft awaiting the required review; nothing merged. The real deployment and C53/C54 remain not verified, as stated. Non-blocking: the sentence saying images are built only after a merge is outdated, since the push run already built them.',
  },
  'preview-profile': {
    checks: [
      ['C1', 'Existing PR kept as a draft'],
      ['C2', 'Conflicts resolved by a merge, no rewrite'],
      ['C3', "No marker left, main's changes kept"],
      ['C4', 'Checks green on the last commit'],
      ['C5', 'C55–C60 and F23 ran in CI'],
      ['C6', 'Rotation and revocation match Pocket-ID 2.18.0'],
      ['C7', 'Diff, PR body and evidence agree'],
      ['X1', 'Compatible with infra-k8s #303'],
    ],
    summary:
      "#162 is shippable at the accepted level of proof, no blocker, and stays a draft. Its limits are declared correctly: it doesn't prove the cluster deployment, the real Traefik routing or the delete operations against a real Pocket-ID; the kubelet propagation delay of that ConfigMap is still unmeasured.",
  },
  'vault-route': {
    checks: [
      ['C1', 'Existing PR kept as a draft'],
      ['C2', 'History kept, no conflict'],
      ['C3', 'CI checks on the last commit'],
      ['C4', 'OFFERED_PROFILES unchanged'],
      ['C5', 'PR body and agora contract agree'],
    ],
    summary:
      'Shippable at the agreed level of proof, no blocker. Still a draft; agora #161 must merge before it. Deployment to the real cluster and the operator bootstrap remain not verified, consistent with the accepted CI-only proof.',
  },
  'kubernetes-route': {
    checks: [
      ['C1', 'PR and branch kept'],
      ['C2', 'History kept, no conflict'],
      ['C3', 'CI on the last commit'],
      ['C4', 'OFFERED_PROFILES unchanged'],
      ['C5', 'PR body, contract and dependencies agree'],
    ],
    summary:
      "Ready to review, nothing blocking, keeping the draft and the merge order agora #160 then infra-k8s #302. The accepted CI proof is present and green on the last commit. Not verified on the real cluster: Cilium, the k0s settings, the charts' RBAC and the application content of logs and ConfigMaps; these limits are declared.",
  },
  'preview-route': {
    checks: [
      ['C1', 'Existing PR kept as a draft'],
      ['C2', 'History kept, no conflict'],
      ['C3', 'CI on the last commit'],
      ['C4', 'OFFERED_PROFILES unchanged'],
      ['C5', 'Matches the agora #162 contract'],
      ['C6', 'Revocation matches Pocket-ID 2.18.0'],
      ['C7', 'PR body matches the head'],
      ['X1', 'Compatible with #301 and #302'],
    ],
    summary:
      'Shippable at the accepted level of proof, no blocker found. Not yet proven in production: Cilium, the network hairpin and the real Pocket-ID; the manual bootstrap is still needed before activation. Minor: the selector `get jobs -l app=previews-refresher` targets a label only the Pods carry. Nothing merged.',
  },
}

/** Every verdict also passed the judge's base rubric, R1–R7. */
export const RUBRIC = 'R1–R7 base rubric: proof, CI, regressions, rules, evidence, security, scope'

export const verdictText = (f: FeatureId) => {
  const v = VERDICTS[f]
  const total = v.checks.length + 7
  return [`pass · ${total} of ${total} checks`, `✓ ${RUBRIC}`, ...v.checks.map(([id, name]) => `✓ ${id}  ${name}`)].join('\n')
}

export const RAW = raw

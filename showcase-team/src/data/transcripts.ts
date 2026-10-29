// The members' and the judge's own Workstreams, as the lanes open them. The members' messages are
// theirs (split from the answers the flow quoted to the lead); the tool calls between them are
// plausible stand-ins, since the run's member threads are not in the lead's snapshot.
import { PR, RAW, VERDICTS, type FeatureId } from './run'

export type Seg =
  | { kind: 'text'; text: string }
  | { kind: 'bash'; command: string; output: string; isError?: boolean }
  | { kind: 'access' }

export type AccessAnswer = 'denied' | 'session' | 'always'

/** One member answer, as the flow quoted it: interim messages run together, then the final one. */
const splitAnswer = (answer: string) => {
  const [first = '', ...rest] = answer.split('\n\n')
  const chunks = first.split(/(?<=[.:?])(?=[A-Z`#*"])/)
  const final = [chunks.pop() ?? '', ...rest].join('\n\n')
  return { interim: chunks, final }
}

const reports2 = RAW.reports2
const reports3 = RAW.reports3
const answerOf = (list: typeof reports2, memberName: string, feature: string) => {
  const r = list.find((x) => x.member === memberName && x.feature === feature)
  if (!r) throw new Error(`no report ${memberName} ${feature}`)
  return { ...splitAnswer(r.answer), report: r.report }
}
const briefOf = (list: typeof RAW.steps2, memberName: string, feature: string) =>
  list.find((s) => s.member === memberName && s.feature === feature)?.brief ?? ''

const t = (text: string): Seg => ({ kind: 'text', text })
const sh = (command: string, output: string, isError?: boolean): Seg => ({ kind: 'bash', command, output, ...(isError && { isError }) })

export type LaneScript = { brief: string; segs: Seg[]; report: { status: string; summary: string } }

const devVault = (access: AccessAnswer): LaneScript => {
  const a = answerOf(reports2, 'dev-1', 'vault-profile')
  const [i0, i1, i2] = a.interim as [string, string, string]
  const granted = access !== 'denied'
  const final = granted
    ? a.final.replace(
        /- \*\*End-to-end test:\*\*[^\n]*/,
        "- **End-to-end test:** with `internet` granted, I read the `check` job's log: the five vault end-to-end tests (C44–C46) pass on agentgateway 1.6.0 against the stand-in MCP.",
      )
    : a.final
  return {
    brief: briefOf(RAW.steps2, 'dev-1', 'vault-profile'),
    report: granted
      ? { ...a.report, summary: a.report.summary.replace(/ I couldn't read the CI logs.*$/, " With internet granted, I read the check job's log: C44–C46 pass on agentgateway 1.6.0.") }
      : a.report,
    segs: [
      sh('git fetch origin && git switch feat/credentials-vault && git merge origin/main --no-edit', "Merge made by the 'ort' strategy.\n 38 files changed, 1210 insertions(+), 402 deletions(-)"),
      sh('comm -12 <(git diff --name-only 929f96b origin/main | sort) <(git diff --name-only origin/main...929f96b | sort)', '(no output: main touches none of the PR\'s files)'),
      t(i0),
      sh('git diff 929f96b origin/main -- .github/workflows/ci.yml | head -12', '+  pull_request:\n+    branches: [main]\n   push:\n     branches: ["**"]'),
      sh('git push origin feat/credentials-vault', '   929f96b..5efeea9  feat/credentials-vault -> feat/credentials-vault'),
      t(i1),
      sh('gh pr checks 161 --watch', 'check           pass  7m41s\nimage (5 jobs)  pass\npropose-infra   skipping'),
      t(i2),
      sh('gh run view 40750218492 --job 123034641048 --log | grep -E "C4[4-6]"', 'failed to get run log: HTTP 403 (the log storage host is outside my access)', true),
      t("The log host is on the open web, which I don't have. I'm asking for `internet` so I can quote the per-test results instead of inferring them."),
      { kind: 'access' },
      t(
        granted
          ? "Granted. The `check` job's log shows the five vault end-to-end tests passing on agentgateway 1.6.0, C44–C46. Last, the PR's state:"
          : "Denied. The test only skips off linux-x64 or without openssl; `ubuntu-latest` has both, so it ran inside the green `check` job. Last, the PR's state:",
      ),
      sh('gh pr view 161 --json isDraft,baseRefName,mergeable,mergeStateStatus', '{"baseRefName":"main","isDraft":true,"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE"}'),
      t(final),
    ],
  }
}

const sreVault = (): LaneScript => {
  const a = answerOf(reports2, 'sre-1', 'vault-route')
  const [i0, i1, i2, i3, i4] = a.interim as [string, string, string, string, string]
  return {
    brief: briefOf(RAW.steps2, 'sre-1', 'vault-route'),
    report: a.report,
    segs: [
      sh('git fetch origin && git switch feat/agora-gateway-vault && git merge origin/main --no-edit', "Merge made by the 'ort' strategy.\n 9 files changed (image digests, apps/agora-sandboxes/catalogue, TEAM_DEPLOYMENT)"),
      t(i0),
      sh('gh pr view 301 --json body -q .body | grep -n -i "contract\\|flow/"', '14:Contract: agora branch `flow/2f42be87/vault-profile` (PR #155), pinned at 929f96b'),
      t(i1),
      sh('git -C ../agora diff --stat 929f96b 5efeea9 -- packages/credentials docs/specs/credentials.md', '(no output)'),
      t(i2),
      sh('git push origin feat/agora-gateway-vault && gh pr checks 301 --watch', '   62fdf7f..5dd1350  feat/agora-gateway-vault -> feat/agora-gateway-vault\ne2e         pass  11m02s\nreconciler  pass  48s'),
      t(i3),
      sh('gh pr view 301 --json body -q .body | sed -n "/## Merge order/,/## /p"', '## Merge order and manual steps\n1. Bootstrap the vault token (see Rotation)\n2. Restart agora-gateway\n…'),
      t(i4),
      sh('gh pr edit 301 --body-file /tmp/pr-301.md', 'https://github.com/arnaultbretagne/infra-k8s/pull/301'),
      t(a.final),
    ],
  }
}

const devKubernetes = (): LaneScript => {
  const a = answerOf(reports2, 'dev-1', 'kubernetes-profile')
  const [i0, i1] = a.interim as [string, string]
  return {
    brief: briefOf(RAW.steps2, 'dev-1', 'kubernetes-profile'),
    report: a.report,
    segs: [
      sh('git switch feat/credentials-kubernetes && grep -n -E "C(49|5[0-4])|R2[12]" docs/reliability/credentials.md | head -5', '212:| C49 | … | proven | R22 |\n213:| C50 | … | proven | R22 |\n216:| C53 | … | not verified | |\n217:| C54 | … | not verified | |'),
      t(i0),
      sh('git merge origin/main --no-edit && node scripts/case-ids.ts', "Merge made by the 'ort' strategy.\ncase IDs: 502 citations, 226 cases, all resolved"),
      t(i1),
      sh('git push origin feat/credentials-kubernetes && gh pr checks 160 --watch', '   2df72a3..e3ed49f  feat/credentials-kubernetes -> feat/credentials-kubernetes\ncheck           pass  8m03s\nimage (5 jobs)  pass'),
      t(a.final),
    ],
  }
}

const sreKubernetes = (): LaneScript => {
  const a = answerOf(reports2, 'sre-1', 'kubernetes-route')
  const [i0, i1, i2, i3, i4] = a.interim as [string, string, string, string, string]
  return {
    brief: briefOf(RAW.steps2, 'sre-1', 'kubernetes-route'),
    report: a.report,
    segs: [
      sh('comm -12 <(git diff --name-only origin/main...origin/feat/agora-gateway-vault | sort) <(git diff --name-only origin/main...HEAD | sort)', 'apps/agora-gateway/gateway.yaml\napps/agora-gateway/kustomization.yaml\napps/agora-gateway/networkpolicy.yaml'),
      t(i0),
      sh('git merge origin/main --no-edit && git push origin feat/agora-gateway-kubernetes && git merge-tree --write-tree origin/feat/agora-gateway-vault HEAD >/dev/null; echo $?', '   e788e0c..124b771  feat/agora-gateway-kubernetes -> feat/agora-gateway-kubernetes\n0'),
      t(i1),
      sh('git -C ../agora diff --stat 2df72a3 e3ed49f -- packages/credentials docs/specs/credentials.md', '(no output)'),
      t(i2),
      sh('gh pr view 302 --json body -q .body | grep -n -E "Merge order|bd6a2c9|62fdf7f"', '31:## Merge order\n44:Checked independent of #301 (main bd6a2c9, #301 62fdf7f): no conflict.'),
      t(i3),
      sh('gh pr checks 302 --watch', 'e2e  pass  14m37s'),
      t(i4),
      sh('gh pr edit 302 --body-file /tmp/pr-302.md', 'https://github.com/arnaultbretagne/infra-k8s/pull/302'),
      t(a.final),
    ],
  }
}

const devPreviews = (): LaneScript => {
  const a = answerOf(reports2, 'dev-1', 'preview-profile')
  const [i0, i1, i2, i3, i4] = a.interim as [string, string, string, string, string]
  return {
    brief: briefOf(RAW.steps2, 'dev-1', 'preview-profile'),
    report: a.report,
    segs: [
      sh('git switch feat/credentials-previews && git merge origin/main', 'Auto-merging docs/specs/credentials.md\nCONFLICT (content): Merge conflict in apps/flows/roles/judge.md\nCONFLICT (content): Merge conflict in docs/reliability/flows.md\nAutomatic merge failed; fix conflicts and then commit the result.', true),
      sh('git diff --check && git grep -n -E "^(<<<<<<<|>>>>>>>)" || echo "no conflict marker"', 'no conflict marker'),
      t(i0),
      sh('git grep -n -i "disable" -- docs apps packages', 'docs/specs/credentials.md:418:… Pocket-ID 2.18.0 offers no way to disable a client, so revoking is deleting its secret by id.'),
      t(i1),
      sh('gh pr view 162 --json body -q .body | grep -n -E "R11|disable"', '38:| flows | F23 | R11 on 74fc848 |\n52:… evidence: flows R11 …'),
      t(i2),
      sh('node scripts/case-ids.ts && git commit --no-edit && git push origin feat/credentials-previews', 'case IDs: 509 citations, 229 cases, all resolved\n   b887ae1..b4b13c8  feat/credentials-previews -> feat/credentials-previews'),
      t(i3),
      sh('gh pr edit 162 --body-file /tmp/pr-162.md && gh pr checks 162 --watch', 'https://github.com/arnaultbretagne/agora/pull/162\ncheck           pass  9m12s\nimage (5 jobs)  pass'),
      t(i4),
      sh('grep -n -E "test:flows|pytest" package.json apps/flows/package.json', 'apps/flows/package.json:7:    "test": "python -m pytest -q"'),
      t(a.final),
    ],
  }
}

const srePreviews = (): LaneScript => {
  const a = answerOf(reports2, 'sre-1', 'preview-route')
  const i = a.interim
  return {
    brief: briefOf(RAW.steps2, 'sre-1', 'preview-route'),
    report: a.report,
    segs: [
      sh('gh pr view 303 --json body -q .body | wc -c', '313'),
      t(i[0]!),
      sh('git switch feat/agora-gateway-previews && git merge origin/main --no-edit', "Merge made by the 'ort' strategy."),
      t(i[1]!),
      sh('git -C ../agora show b4b13c8:docs/specs/credentials.md | sed -n "/^## Previews/,/^## /p" | head -30', '## Previews\n\nHost `*.preview.bretagne.dev`, rule on the grant\'s `hostPattern`, header `x-agora-gate: gateway` …'),
      t(i[3]!),
      sh('sed -n "/2026-10-27/,/^## /p" docs/adr/0017-preview-in-prod.md | head -20', 'Amendment, 2026-10-27: … contract `flow/2f42be87/preview-profile` (PR #155), implementation #297 …'),
      t(i[5]!),
      sh('git -C ../agora diff --stat b887ae1 b4b13c8 -- packages/credentials docs/specs/credentials.md', '(no output)'),
      t(i[9]!),
      sh('git commit -am "docs: ADR 0017 cites #162 and #303, Pocket-ID 2.18.0 revocation" && git push origin feat/agora-gateway-previews', '   c3a3ff3..755737d  feat/agora-gateway-previews -> feat/agora-gateway-previews'),
      t(i[10]!),
      sh('grep -rn "test_reconcile_previews" .github/workflows', '.github/workflows/agora-gateway-e2e.yaml:88:        run: python -m pytest apps/agora-gateway/test/test_reconcile_previews.py'),
      t(i[14]!),
      sh('gh pr checks 303 --watch', 'e2e  pass  31m12s'),
      t(i[15]!),
      sh('gh pr edit 303 --body-file /tmp/pr-303.md', 'https://github.com/arnaultbretagne/infra-k8s/pull/303'),
      t(a.final),
    ],
  }
}

/** dev-1's second pass: the spec text in #161 and #162 aligned with what infra-k8s #301 builds. */
const devSpec = (): LaneScript => {
  const v = answerOf(reports3, 'dev-1', 'vault-profile')
  const p = answerOf(reports3, 'dev-1', 'preview-profile')
  const b161 = briefOf(RAW.steps3, 'dev-1', 'vault-profile')
  const b162 = briefOf(RAW.steps3, 'dev-1', 'preview-profile')
  return {
    brief: `${b161}\n\n---\n\nThen, on #162: ${b162}`,
    report: {
      status: 'done',
      summary: `#161: ${v.report.summary.split('. ')[0]}. #162: ${p.report.summary.split('. ')[0]}.`,
    },
    segs: [
      t(v.interim[1]!),
      sh('gh api "repos/arnaultbretagne/infra-k8s/contents/apps/agora-gateway/gateway.yaml?ref=5dd1350" -q .content | base64 -d | grep -n -B2 -A2 statefulMode', '39-    mcp:\n40-      targets: [{ name: vault, host: obsidian-mcp.obsidian.svc:4000 }]\n41:      statefulMode: stateless'),
      t(v.interim[2]!),
      sh('node /tmp/edit-spec.mjs docs/specs/credentials.md docs/adr/000n-gateway.md', '3 rows replaced in docs/specs/credentials.md, 1 line in docs/adr/000n-gateway.md'),
      t(v.interim[4]!),
      t(v.interim[5]!),
      sh('git commit -am "docs: the vault route as infra-k8s #301 builds it" && git push origin feat/credentials-vault && gh pr edit 161 --body-file /tmp/pr-161.md', '   5efeea9..ba52715  feat/credentials-vault -> feat/credentials-vault\nhttps://github.com/arnaultbretagne/agora/pull/161'),
      t(v.interim[6]!),
      sh('gh pr checks 161 --watch', 'check  pass  7m55s'),
      t(p.interim[0]!),
      sh('git switch feat/credentials-previews && grep -n -i "vault" docs/specs/credentials.md', '402:**Keeping the token.** `previews-refresher` in `agora-gateway`, as `vault-refresher`: every 5 minutes …\n431:| Backend | … `vault.bretagne.dev/health` answered 200 through `internet` on 2026-10-27 … |'),
      t(p.interim[1]!),
      sh('gh api "repos/arnaultbretagne/infra-k8s/contents/apps/agora-gateway/previews-refresher.yaml?ref=755737d" -q .content | base64 -d | grep -n -E "schedule|secretName"', '9:  schedule: "*/5 * * * *"\n31:            secretName: previews-client'),
      t(p.interim[2]!),
      sh('gh pr checks 162 --watch', 'check  pass  8m20s'),
      t(`${v.final}\n\n---\n\n${p.final}`),
    ],
  }
}

export type LaneId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7'

export const laneScript = (lane: LaneId, access: AccessAnswer): LaneScript => {
  switch (lane) {
    case 'L1':
      return devVault(access)
    case 'L2':
      return sreVault()
    case 'L3':
      return devKubernetes()
    case 'L4':
      return sreKubernetes()
    case 'L5':
      return devPreviews()
    case 'L6':
      return srePreviews()
    case 'L7':
      return devSpec()
  }
}

const DIFF_FILES: Record<FeatureId, number> = {
  'vault-profile': 14,
  'kubernetes-profile': 19,
  'preview-profile': 23,
  'vault-route': 19,
  'kubernetes-route': 12,
  'preview-route': 21,
}

/** A judge's own Workstream: read-only checks, then its verdict (translated). */
export const judgeScript = (feature: FeatureId, lost = false): { brief: string; segs: Seg[] } => {
  const pr = PR[feature]
  const segs: Seg[] = [
    t(`Checking PR ${pr.repo} #${pr.n} against its criteria and the base rubric, read-only. First, its state and history.`),
    sh(`gh pr view ${pr.n} -R arnaultbretagne/${pr.repo} --json isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus`, `{"baseRefName":"main","headRefName":"${pr.branch}","headRefOid":"${pr.head}…","isDraft":true,"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE"}`),
    sh(`git merge-base --is-ancestor ${pr.oldHead} origin/${pr.branch} && git merge-base --is-ancestor origin/main origin/${pr.branch} && echo both-ancestors`, 'both-ancestors'),
  ]
  if (lost) return { brief: RAW.verifyQuestions[feature], segs: [...segs, t('History holds. Now the CI run on the head and its log.')] }
  return {
    brief: RAW.verifyQuestions[feature],
    segs: [
      ...segs,
      t('History holds. Now the CI run on the head and its log.'),
      sh(`gh run view ${pr.run} -R arnaultbretagne/${pr.repo} --log | grep -E "^(# pass|# fail|ok |not ok)" | tail -4`, '# pass 19\n# fail 0'),
      sh(`git diff --stat origin/main...origin/${pr.branch} | tail -1`, ` ${DIFF_FILES[feature]} files changed`),
      t(VERDICTS[feature].summary),
    ],
  }
}

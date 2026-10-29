// The run as a sequence of moments. Every view is a projection of the same moment: the lead's thread
// (as the ExternalStoreRuntime's messages), and the Agents folder (as background runs).
import { fromThreadMessageLike, type ThreadMessage, type ThreadMessageLike } from '@assistant-ui/react'
import type { BackgroundRun } from '@/components/assistant-ui/elements/background-inbox'
import { FEATURE_ORDER, LIMITS, PLAN, PR, RAW, VERDICTS, member, prLabel, prUrl, verdictText, GOAL, type FeatureId } from './run'
import { judgeScript, laneScript, type AccessAnswer, type LaneId, type Seg } from './transcripts'

export type PlanAnswer = 'approve' | 'revise' | 'stop'
export type Answers = { plan?: PlanAnswer | undefined; access?: AccessAnswer | undefined }

export const STEPS = [
  { label: 'You give the lead the goal', min: 0 },
  { label: 'The lead reads the six PRs', min: 1 },
  { label: 'The lead asks you to approve the envelope', min: 4 },
  { label: 'Approved: dev-1 and sre-1 start on the vault right', min: 11 },
  { label: 'dev-1 asks you for internet', min: 17 },
  { label: 'dev-1 finishes vault-profile; the lead starts #160', min: 25 },
  { label: 'sre-1 finishes vault-route and flags a spec gap', min: 30 },
  { label: 'The Kubernetes right is done; dev-1 takes #162', min: 41 },
  { label: '#162 is out of conflict; sre-1 takes #303, dev-1 fixes the spec', min: 67 },
  { label: 'All six are green; the lead sends them to the judge', min: 105 },
  { label: 'Three verdicts back; one judge session was lost', min: 119 },
  { label: 'All six pass; the lead ends the run', min: 132 },
] as const
export const LAST_STEP = STEPS.length - 1
export const PLAN_STEP = 2
export const ACCESS_STEP = 4

type Lane = {
  id: LaneId
  member: string
  feature: FeatureId
  title: string
  from: number
  to: number
  startMin: number
  endMin: number
  /** How many segments of the script are visible while the lane runs, per step. */
  partial: Record<number, number>
  result: string
  report: string
}

const LANES: Lane[] = [
  { id: 'L1', member: 'dev-1', feature: 'vault-profile', title: 'vault-profile · #161 up to date', from: 3, to: 5, startMin: 11, endMin: 24, partial: { 3: 6, 4: 11 }, result: 'done · head 5efeea9 · CI green · nothing beyond the merge', report: '' },
  { id: 'L2', member: 'sre-1', feature: 'vault-route', title: 'vault-route · #301 up to date', from: 3, to: 6, startMin: 11, endMin: 29, partial: { 3: 2, 4: 4, 5: 7 }, result: 'done · head 5dd1350 · CI green · PR body updated · flags a spec gap', report: 'Merged main, no conflict. Head 5dd1350; e2e and reconciler green; PR body brought up to date. Flags: agora\'s spec still describes a stateful backend and a vault-refresher that #301 does not have.' },
  { id: 'L3', member: 'dev-1', feature: 'kubernetes-profile', title: 'kubernetes-profile · #160 up to date', from: 5, to: 7, startMin: 25, endMin: 36, partial: { 5: 2, 6: 4 }, result: 'done · head e3ed49f · CI green · merges alone', report: 'Merged main, no conflict. Head e3ed49f; CI green. #160 and #161 each merge alone; whichever merges second will need main again.' },
  { id: 'L4', member: 'sre-1', feature: 'kubernetes-route', title: 'kubernetes-route · #302 up to date', from: 6, to: 7, startMin: 30, endMin: 40, partial: { 6: 5 }, result: 'done · head 124b771 · CI green · merges with #301 too', report: 'Merged main, no conflict. Head 124b771; e2e green on kind. Merges alone, and together with #301.' },
  { id: 'L5', member: 'dev-1', feature: 'preview-profile', title: 'preview-profile · #162 conflicts', from: 7, to: 8, startMin: 41, endMin: 66, partial: { 7: 5 }, result: 'done · head b4b13c8 · 2 conflicts resolved · CI green', report: "Resolved 2 conflicts (judge.md; flows R11 → R12). Head b4b13c8; CI green. Revocation already matches Pocket-ID 2.18.0; #303's contract unchanged." },
  { id: 'L6', member: 'sre-1', feature: 'preview-route', title: 'preview-route · #303 up to date', from: 8, to: 9, startMin: 67, endMin: 104, partial: { 8: 6 }, result: 'done · head 755737d · CI green · full PR body written', report: 'Merged main, no conflict. Head 755737d; e2e green. Wrote the full PR body; ADR 0017 now cites #162 and #303. No gap with #162.' },
  { id: 'L7', member: 'dev-1', feature: 'vault-profile', title: 'spec text · #161 and #162', from: 8, to: 9, startMin: 67, endMin: 96, partial: { 8: 4 }, result: 'done · #161 at ba52715, #162 at 2a24f3d · spec text only · CI green', report: 'Spec text only: the vault route now reads stateless, with a hand-minted 90-day token (#161 → ba52715); the previews refresher stands on its own (#162 → 2a24f3d). CI green.' },
]

type Verify = { id: string; feature: FeatureId; from: number; to: number; startMin: number; endMin: number; lost?: boolean; report: string }

const VERIFIES: Verify[] = [
  { id: 'V1', feature: 'vault-profile', from: 9, to: 10, startMin: 105, endMin: 113, report: 'pass · 13 of 13 checks at ba52715. Not verified: the real cluster.' },
  { id: 'V2', feature: 'kubernetes-profile', from: 9, to: 10, startMin: 105, endMin: 116, report: 'pass · 14 of 14 at e3ed49f. Non-blocking: a stale sentence about when images are built.' },
  { id: 'V3', feature: 'preview-profile', from: 9, to: 11, startMin: 105, endMin: 124, report: 'pass · 15 of 15 at 2a24f3d. Revocation matches Pocket-ID 2.18.0.' },
  { id: 'V4', feature: 'vault-route', from: 9, to: 11, startMin: 105, endMin: 121, report: 'pass · 12 of 12 at 5dd1350. agora #161 merges first.' },
  { id: 'V5', feature: 'kubernetes-route', from: 9, to: 10, startMin: 105, endMin: 111, lost: true, report: 'No verdict: the session was lost (execution ended: claim_missing). Nothing counted.' },
  { id: 'V6', feature: 'preview-route', from: 9, to: 11, startMin: 105, endMin: 129, report: 'pass · 15 of 15 at 755737d. Minor: a selector targets a label only the Pods carry.' },
  { id: 'V7', feature: 'kubernetes-route', from: 10, to: 11, startMin: 119, endMin: 130, report: 'pass · 12 of 12 at 124b771. agora #160 merges first.' },
]

const LOST_RESULT = "No verdict: the judge's session was lost (execution ended: claim_missing). No verification counted."

export const ACCESS_OPTIONS = [
  { id: 'session', kind: 'allow-once', label: 'This session' },
  { id: 'always', kind: 'allow-always', label: 'Always' },
  { id: 'deny', kind: 'reject-once', label: 'Deny' },
] as const
export const PLAN_OPTIONS = [
  { id: 'approve', kind: 'allow-once', label: 'Approve' },
  { id: 'revise', kind: 'reject-once', label: 'Revise' },
  { id: 'stop', kind: 'reject-always', label: 'Stop' },
] as const

export type ReportTurn = {
  id: string
  who: string
  detail: string
  status: 'done' | 'pass' | 'failed'
  feature: FeatureId
  text: string
  href?: string
  link?: string
}

const harnessOf = (name: string) => {
  if (name === 'judge') return 'codex · gpt-6.1-sol · xhigh'
  const m = member(name)
  return `${m.harness} · ${m.model} · ${m.effort}`
}

export const accessArgs = {
  member: 'dev-1',
  feature: 'vault-profile',
  access: 'internet',
  gives: 'the open web: packages, documentation',
  why: "Read the CI job logs, to quote the vault end-to-end tests' results. The log storage host returns 403 without internet.",
}

export const planArgs = {
  title: PLAN.title,
  why: PLAN.why,
  features: PLAN.features,
  team: PLAN.team,
  judge: 'codex · gpt-6.1-sol · xhigh, a fresh context each time, read-only',
  limits: LIMITS,
}

export const doneArgs = { why: RAW.done.why, summary: RAW.done.summary, features: FEATURE_ORDER }

type Part = Exclude<ThreadMessageLike['content'], string>[number]
type Snapshot = { messages: ThreadMessageLike[]; isRunning: boolean }

export function buildThread(step: number, answers: Answers, now: number): Snapshot {
  const base = now - STEPS[step]!.min * 60_000
  const at = (min: number) => base + min * 60_000
  const access: AccessAnswer = step > ACCESS_STEP ? (answers.access ?? 'denied') : answers.access ?? 'denied'
  const planAnswer: PlanAnswer | undefined = step > PLAN_STEP ? 'approve' : step === PLAN_STEP ? answers.plan : undefined
  const accessAnswered = step > ACCESS_STEP || (step === ACCESS_STEP && answers.access !== undefined)

  const accessApproval = () => ({
    id: 'approval-access',
    prompt: `dev-1 asks for ${accessArgs.access}`,
    options: ACCESS_OPTIONS,
    ...(accessAnswered && { approved: access !== 'denied', optionId: access === 'denied' ? 'deny' : access }),
  })
  const accessResult = () => (accessAnswered ? (access === 'denied' ? 'denied by the person' : `granted · ${access}`) : undefined)

  const segPart = (laneKey: string, seg: Seg, i: number, open: boolean): Part => {
    if (seg.kind === 'text') return { type: 'text', text: seg.text }
    if (seg.kind === 'access') {
      const result = accessResult()
      return { type: 'tool-call', toolCallId: `${laneKey}-access`, toolName: 'request_access', args: accessArgs, approval: accessApproval(), ...(result !== undefined && { result }) }
    }
    return {
      type: 'tool-call',
      toolCallId: `${laneKey}-t${i}`,
      toolName: 'Bash',
      args: { command: seg.command },
      ...(!open && { result: seg.output, ...(seg.isError && { isError: true }) }),
    }
  }

  const transcript = (key: string, brief: string, segs: Seg[], shown: number, state: 'running' | 'done' | 'lost', startedMin: number): ThreadMessage[] => {
    const visible = segs.slice(0, shown)
    const parts = visible.map((seg, i) => segPart(key, seg, i, state === 'running' && i === visible.length - 1 && seg.kind === 'bash'))
    const user = fromThreadMessageLike({ role: 'user', id: `${key}-brief`, createdAt: new Date(at(startedMin)), content: [{ type: 'text', text: brief }] }, `${key}-brief`, { type: 'complete', reason: 'unknown' })
    const status =
      state === 'running'
        ? ({ type: 'running' } as const)
        : state === 'lost'
          ? ({ type: 'incomplete', reason: 'error', error: 'execution ended: claim_missing' } as const)
          : ({ type: 'complete', reason: 'stop' } as const)
    const assistant = fromThreadMessageLike({ role: 'assistant', id: `${key}-turn`, createdAt: new Date(at(startedMin)), content: parts, status }, `${key}-turn`, status)
    return [user, assistant]
  }

  const startPart = (lane: Lane): Part | undefined => {
    if (step < lane.from) return undefined
    const script = laneScript(lane.id, access)
    const done = step >= lane.to
    const shown = done ? script.segs.length : (lane.partial[step] ?? Math.ceil(script.segs.length / 2))
    return {
      type: 'tool-call',
      toolCallId: lane.id,
      toolName: 'start',
      args: { member: lane.member, feature: lane.feature, title: lane.title, agent: lane.member, brief: script.brief },
      messages: transcript(lane.id, script.brief, script.segs, shown, done ? 'done' : 'running', lane.startMin),
      timing: { startedAt: at(lane.startMin), ...(done && { completedAt: at(lane.endMin) }) },
      ...(done && { result: lane.result }),
    }
  }

  const verifyPart = (v: Verify): Part | undefined => {
    if (step < v.from) return undefined
    const script = judgeScript(v.feature, v.lost)
    const done = step >= v.to
    const shown = done ? script.segs.length : Math.min(3, script.segs.length)
    const pr = PR[v.feature]
    return {
      type: 'tool-call',
      toolCallId: v.id,
      toolName: 'verify',
      args: { feature: v.feature, title: `${v.feature} · #${pr.n} at ${pr.head}`, agent: 'judge', shippable: true, question: script.brief },
      messages: transcript(v.id, script.brief, script.segs, shown, done ? (v.lost ? 'lost' : 'done') : 'running', v.startMin),
      timing: { startedAt: at(v.startMin), ...(done && { completedAt: at(v.endMin) }) },
      ...(done && (v.lost ? { result: LOST_RESULT, isError: true } : { result: verdictText(v.feature) })),
    }
  }

  const lane = (id: LaneId) => LANES.find((l) => l.id === id)!
  const verify = (id: string) => VERIFIES.find((v) => v.id === id)!

  const laneReport = (l: Lane): ReportTurn => {
    const summary = l.id === 'L1' ? (access === 'denied' ? "Merged main into feat/credentials-vault, no conflict, nothing beyond the merge. Head 5efeea9; both CI runs green. Couldn't read the per-test logs: internet denied." : 'Merged main into feat/credentials-vault, no conflict, nothing beyond the merge. Head 5efeea9; both CI runs green; the check log shows C44–C46 passing.') : l.report
    return { id: `report-${l.id}`, who: l.member, detail: harnessOf(l.member), status: 'done', feature: l.feature, text: summary, href: prUrl(l.feature), link: `PR ${prLabel(l.feature)}` }
  }
  const verifyReport = (v: Verify): ReportTurn => ({
    id: `report-${v.id}`,
    who: 'judge',
    detail: harnessOf('judge'),
    status: v.lost ? 'failed' : 'pass',
    feature: v.feature,
    text: v.report,
    ...(!v.lost && { href: prUrl(v.feature), link: `PR ${prLabel(v.feature)}` }),
  })

  const reports = (id: string, from: number, turns: ReportTurn[]): ThreadMessageLike | undefined =>
    step < from
      ? undefined
      : {
          role: 'user',
          id,
          createdAt: new Date(at(STEPS[from]!.min)),
          content: [{ type: 'text', text: turns.map((r) => `${r.who} · ${r.status} · ${r.feature}: ${r.text}`).join('\n') }],
          metadata: { custom: { reports: turns } },
        }

  const assistant = (id: string, from: number, parts: (Part | undefined | false)[]): ThreadMessageLike | undefined =>
    step < from ? undefined : { role: 'assistant', id, createdAt: new Date(at(STEPS[from]!.min)), content: parts.filter((p): p is Part => !!p) }

  const reads: Part[] = [
    { type: 'text', text: 'Reading the six PRs, their descriptions and acceptance criteria first.' },
    { type: 'tool-call', toolCallId: 'read-1', toolName: 'Bash', args: { command: "cd /tmp && node f.mjs   # the six PRs: title, state, head, mergeable, body" }, result: '=== agora#161 … draft, mergeable, 21 behind\n=== agora#160 … draft, mergeable, 21 behind\n=== agora#162 … draft, mergeable_state: dirty\n=== infra-k8s#301 … draft, 6 behind\n=== infra-k8s#302 … draft, 6 behind\n=== infra-k8s#303 … draft, body: 313 bytes' },
    { type: 'tool-call', toolCallId: 'read-2', toolName: 'Bash', args: { command: 'grep -n -i -E "^=== |^#+ |criter|accept|done when" prs.txt | head -120' }, result: '41 matching lines across the six bodies' },
    {
      type: 'tool-call',
      toolCallId: 'read-3',
      toolName: 'Bash',
      args: { command: "sed -n '42,69p;105,121p;150,167p' prs.txt" },
      ...(step >= 2 && { result: '## Proof\n- e2e on agentgateway 1.6.0 against the stand-in MCP (C44–C46) …\n## Merge order\n…' }),
    },
  ]

  const planPart: Part | false = step >= PLAN_STEP && {
    type: 'tool-call',
    toolCallId: 'plan',
    toolName: 'plan',
    args: planArgs,
    approval: {
      id: 'approval-plan',
      prompt: 'Approve the envelope',
      options: PLAN_OPTIONS,
      ...(planAnswer && { approved: planAnswer === 'approve', optionId: planAnswer }),
    },
    ...(step > PLAN_STEP && { result: 'approved: the run started within this envelope' }),
  }

  const leadA = assistant('lead-a', 1, [
    ...reads,
    step >= PLAN_STEP && { type: 'text', text: "Six features, two members, with the access the goal sets. The acceptance criteria come from each PR's description, plus checks anyone can run on the merge and the CI." },
    planPart,
    step >= 3 && { type: 'text', text: 'Approved. dev-1 and sre-1 start on the vault right side by side: dev-1 brings agora #161 up to date, sre-1 its route infra-k8s #301, which it checks against #161 once dev-1 has pushed.' },
    startPart(lane('L1')),
    startPart(lane('L2')),
  ])

  const accessResultNow = accessResult()
  const crossPost = assistant('access-dev-1', ACCESS_STEP, [
    {
      type: 'tool-call',
      toolCallId: 'access-dev-1',
      toolName: 'request_access',
      args: accessArgs,
      approval: accessApproval(),
      ...(accessResultNow !== undefined && { result: accessResultNow }),
    },
  ])

  const messages = [
    { role: 'user', id: 'goal', createdAt: new Date(at(0)), content: [{ type: 'text', text: GOAL }] } as ThreadMessageLike,
    leadA,
    crossPost,
    reports('reports-1', 5, [laneReport(lane('L1'))]),
    assistant('lead-b', 5, [{ type: 'text', text: '#161 is up to date and green on 5efeea9. dev-1 goes on with #160.' }, startPart(lane('L3'))]),
    reports('reports-2', 6, [laneReport(lane('L2'))]),
    assistant('lead-c', 6, [
      { type: 'text', text: "#301 is green on 5dd1350. sre-1 takes #302. The gap sre-1 found (agora's spec describes a stateful backend and a `vault-refresher` that #301 doesn't have) goes to dev-1 once #162 is updated." },
      startPart(lane('L4')),
    ]),
    reports('reports-3', 7, [laneReport(lane('L3')), laneReport(lane('L4'))]),
    assistant('lead-d', 7, [{ type: 'text', text: 'Both Kubernetes PRs are green, and each merges alone. dev-1 takes #162, the one in conflict.' }, startPart(lane('L5'))]),
    reports('reports-4', 8, [laneReport(lane('L5'))]),
    assistant('lead-e', 8, [
      { type: 'text', text: "#162 is out of conflict and its contract for #303 is unchanged. sre-1 takes #303; meanwhile dev-1 aligns the agora spec with what #301 builds, before anything goes to the judge." },
      startPart(lane('L6')),
      startPart(lane('L7')),
    ]),
    reports('reports-5', 9, [laneReport(lane('L7')), laneReport(lane('L6'))]),
    assistant('lead-f', 9, [
      { type: 'text', text: "All six branches are up to date and green, and the spec now matches #301. I'd bet on all six: sending them to the judge." },
      ...['V1', 'V2', 'V3', 'V4', 'V5', 'V6'].map((id) => verifyPart(verify(id))),
    ]),
    reports('reports-6', 10, [verifyReport(verify('V5')), verifyReport(verify('V1')), verifyReport(verify('V2'))]),
    assistant('lead-g', 10, [
      { type: 'text', text: "vault-profile and kubernetes-profile pass. The judge's session on kubernetes-route was lost before any verdict, so it cost nothing: asking again." },
      verifyPart(verify('V7')),
    ]),
    reports('reports-7', 11, [verifyReport(verify('V4')), verifyReport(verify('V3')), verifyReport(verify('V6')), verifyReport(verify('V7'))]),
    assistant('lead-h', 11, [
      { type: 'text', text: RAW.done.prose },
      { type: 'tool-call', toolCallId: 'done', toolName: 'done', args: doneArgs, result: 'ended' },
    ]),
  ].filter((m): m is ThreadMessageLike => m !== undefined)

  return { messages, isRunning: step === 1 }
}

/** The Agents folder at a moment: one row per member Workstream, from Agora's own bookkeeping. */
export function agentsAt(step: number, answers: Answers): BackgroundRun[] {
  const min = STEPS[step]!.min
  const ago = (m: number) => {
    const d = Math.max(0, Math.round(min - m))
    return d < 1 ? 'just now' : d < 60 ? `${d}m ago` : `${Math.floor(d / 60)}h ${d % 60}m ago`
  }
  const runFor = (m: number) => {
    const d = Math.max(1, Math.round(min - m))
    return d < 60 ? `${d}m` : `${Math.floor(d / 60)}h ${d % 60}m`
  }
  const rows: BackgroundRun[] = []
  for (const name of ['dev-1', 'sre-1']) {
    const turns = LANES.filter((l) => l.member === name && l.from <= step)
    if (turns.length === 0) continue
    const current = turns.find((l) => step < l.to)
    const last = turns.filter((l) => step >= l.to).at(-1)
    if (current) {
      const waiting = current.id === 'L1' && step === ACCESS_STEP && answers.access === undefined
      rows.push({ id: name, title: `${name} · ${harnessOf(name)}`, state: 'running', elapsed: runFor(current.startMin), summary: waiting ? `${current.feature}: waiting for your answer on internet` : `working on ${current.title}` })
    } else if (last) {
      rows.push({ id: name, title: `${name} · ${harnessOf(name)}`, state: 'ready', elapsed: ago(last.endMin), summary: `${last.feature}: ${last.result}` })
    }
  }
  for (const v of VERIFIES) {
    if (step < v.from) continue
    const title = `judge · ${v.feature}${v.id === 'V7' ? ' (again)' : ''}`
    if (step < v.to) rows.push({ id: v.id, title, state: 'running', elapsed: runFor(v.startMin), summary: `${prLabel(v.feature)} at ${PR[v.feature].head}` })
    else rows.push({ id: v.id, title, state: v.lost ? 'failed' : 'ready', elapsed: ago(v.endMin), summary: v.lost ? 'execution ended: claim_missing · no verdict' : `pass · ${VERDICTS[v.feature].checks.length + 7} checks` })
  }
  return rows
}

/** The run's tasks for the Subagent list: the feature as the name, who works on it as the model line. */
export const subagentName = (_toolName: string, args: Record<string, unknown>) => String(args.feature)
export const subagentModel = (toolName: string, args: Record<string, unknown>) => {
  if (toolName === 'verify') return 'judge · gpt-6.1-sol'
  const m = member(String(args.member))
  return `${m.name} · ${m.model} · ${m.effort}`
}

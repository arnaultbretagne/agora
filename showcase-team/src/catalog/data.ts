// One small example, the same in every frame: a team of one dev and the judge on one feature.
// The tool calls are shaped as the Agora MCP would send them (start, verify, propose); the frames
// only change which assistant-ui piece renders them.
import { fromThreadMessageLike, type ThreadMessage, type ThreadMessageLike } from '@assistant-ui/react'

type Part = Exclude<ThreadMessageLike['content'], string>[number]

const MIN = 60_000
const now = Date.now()

export const GOAL = 'Export a Workstream as Markdown, from its menu.'
export const FEATURE = 'export-markdown'
export const BRANCH = 'feat/export-markdown'
export const CRITERIA = [
  'C1 The Workstream menu has “Export as Markdown”',
  'C2 The file holds every exchange, in order',
  'C3 CI is green on the last commit',
]
export const DEV = { name: 'dev-1', harness: 'claude-code · opus · high', rights: ['github:arnaultbretagne/agora:write', 'internet'] }
export const JUDGE = 'codex · gpt-6.1-sol · xhigh, read-only'
export const LIMITS = '1 member at a time · 3 verifications per feature'

export const ENVELOPE = {
  title: 'Export a Workstream as Markdown',
  goal: GOAL,
  features: [{ id: FEATURE, repo: 'arnaultbretagne/agora', branch: BRANCH, criteria: CRITERIA }],
  team: [{ name: DEV.name, role: 'dev', harness: 'claude-code', model: 'opus', effort: 'high', rights: DEV.rights }],
  limits: { parallel: 1, verificationsPerFeature: 3 },
}

export const GRANTS = [
  'dev-1 · github:arnaultbretagne/agora:write',
  'dev-1 · internet',
  'judge (Agora’s) · github:arnaultbretagne/agora:read · internet',
]

const options = [
  { id: 'approve', kind: 'allow-once', label: 'Approve', grants: GRANTS },
  { id: 'revise', kind: 'reject-once', label: 'Revise' },
  { id: 'stop', kind: 'reject-always', label: 'Stop' },
] as const

const PROMPT = `Approve this envelope? 1 feature (${FEATURE}, 3 criteria) · dev-1 on claude-code · opus · judge on codex · ${LIMITS}.`

export const proposePart = (answered: boolean): Part => ({
  type: 'tool-call',
  toolCallId: answered ? 'propose-answered' : 'propose-asking',
  toolName: 'propose',
  args: ENVELOPE,
  approval: {
    id: answered ? 'envelope-answered' : 'envelope-asking',
    prompt: PROMPT,
    allowFreeform: true,
    options,
    ...(answered && { approved: true, optionId: 'approve', text: 'The CI end-to-end test is the proof; no preview.' }),
  },
  ...(answered && { result: 'approved · envelope v1 · 3f9a07c1' }),
})

const done = { type: 'complete', reason: 'stop' } as const

const message = (like: ThreadMessageLike, id: string, status: ThreadMessage['status'] = done): ThreadMessage =>
  fromThreadMessageLike({ ...like, id }, id, status!)

const BRIEF =
  'Add “Export as Markdown” to the Workstream menu. The file holds every exchange in order, as the catch-up writes it. Out of scope: other formats, attachments.'

const devTranscript = (running: boolean): ThreadMessage[] => [
  message({ role: 'user', content: [{ type: 'text', text: BRIEF }] }, 'dev-brief'),
  message(
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'The menu lives in shell.tsx; the exchanges come from the catch-up’s format.' },
        { type: 'tool-call', toolCallId: 'dev-t1', toolName: 'Bash', args: { command: 'grep -rn "WorkstreamMenu" apps/web/src' }, result: 'apps/web/src/screen/shell.tsx:212' },
        { type: 'tool-call', toolCallId: 'dev-t2', toolName: 'Edit', args: { file: 'apps/web/src/screen/shell.tsx' }, result: '+18 −2' },
        ...(running
          ? [{ type: 'tool-call', toolCallId: 'dev-t3', toolName: 'Bash', args: { command: 'npm run check' } } as Part]
          : [{ type: 'text', text: 'Pushed to feat/export-markdown, draft PR #170, CI green.' } as Part]),
      ],
    },
    'dev-turn',
    running ? { type: 'running' } : done,
  ),
]

const judgeTranscript: ThreadMessage[] = [
  message({ role: 'user', content: [{ type: 'text', text: 'Verify export-markdown at 3f2a91c: R1–R7, then C1–C3.' }] }, 'judge-brief'),
  message(
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'judge-t1', toolName: 'Bash', args: { command: 'gh pr checks 170' }, result: 'check · pass' },
        { type: 'text', text: 'All checks pass; one note on the menu entry.' },
      ],
    },
    'judge-turn',
  ),
]

export const VERDICT_TEXT = 'PASS on 3f2a91c\nR1–R7 pass · C1 pass · C2 pass · C3 pass\nNote: the menu entry has no keyboard shortcut.'

export const startPart = (running: boolean): Part => ({
  type: 'tool-call',
  toolCallId: running ? 'start-running' : 'start-done',
  toolName: 'start',
  args: { agent: DEV.name, description: 'Export a Workstream as Markdown', feature: FEATURE, instructions: BRIEF },
  messages: devTranscript(running),
  timing: { startedAt: now - 12 * MIN, ...(!running && { completedAt: now - 2 * MIN }) },
  ...(!running && { result: 'dev-1 finished: draft PR #170, CI green.' }),
})

export const verifyPart: Part = {
  type: 'tool-call',
  toolCallId: 'verify-1',
  toolName: 'verify',
  args: { feature: FEATURE, description: 'Verify export-markdown', focus: 'The export’s order against the thread; CI on the last commit.' },
  messages: judgeTranscript,
  timing: { startedAt: now - 30 * MIN, completedAt: now - 24 * MIN },
  result: VERDICT_TEXT,
}

export const goal: ThreadMessageLike = { role: 'user', id: 'goal', content: [{ type: 'text', text: GOAL }] }
export const say = (id: string, ...content: Part[]): ThreadMessageLike => ({ role: 'assistant', id, content })

export const SCORE = [
  { label: 'R1 Does what was asked', score: 10, weight: 1, note: 'Exported a 40-exchange Workstream; order matches.' },
  { label: 'R2 Green', score: 10, weight: 1, note: 'check passes on 3f2a91c.' },
  { label: 'R3 Nothing broken', score: 10, weight: 1 },
  { label: 'R4 House rules', score: 10, weight: 1 },
  { label: 'R5 Honest', score: 10, weight: 1 },
  { label: 'R6 Safe', score: 10, weight: 1 },
  { label: 'R7 In scope', score: 10, weight: 1 },
  { label: 'C1 Menu entry', score: 10, weight: 1 },
  { label: 'C2 Every exchange, in order', score: 10, weight: 1 },
  { label: 'C3 CI green', score: 10, weight: 1 },
]

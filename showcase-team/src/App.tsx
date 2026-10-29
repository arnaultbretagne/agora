// A static catalogue: for each thing the person must see or do while a team works, the assistant-ui
// pieces that answer it, unmodified, side by side, on one example. No scenario, no state machine.
import { AgentPlan } from '@/components/assistant-ui/elements/agent-plan'
import { AgentStatus, TaskTray } from '@/components/assistant-ui/elements/agent-status.aui'
import { ApprovalCard } from '@/components/assistant-ui/elements/approval-card'
import { OptionList } from '@/components/assistant-ui/elements/option-list'
import { PermissionGrant } from '@/components/assistant-ui/elements/permission-grant'
import { ScoreBreakdown } from '@/components/assistant-ui/elements/score-breakdown'
import { SpeakerIdentity } from '@/components/assistant-ui/elements/speaker-identity'
import { SubagentList } from '@/components/assistant-ui/elements/subagent-list'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BRANCH, CRITERIA, DEV, FEATURE, GOAL, GRANTS, JUDGE, LIMITS, SCORE, goal, proposePart, say, startPart, verifyPart } from '@/catalog/data'
import { DETAILS } from '@/catalog/details'
import { FrozenRuntime, FrozenThread } from '@/catalog/Frozen'
import { TOGETHER_CONFIG } from '@/catalog/toolkit'
import { Need, Option, State } from '@/catalog/Option'

const noop = () => {}


const ENVELOPE_OPTIONS = [
  { id: 'approve', label: 'Approve', description: 'The team starts within this envelope.' },
  { id: 'revise', label: 'Revise', description: 'Your note goes to the lead, who proposes again.' },
  { id: 'stop', label: 'Stop', description: 'No team.' },
]

const proposing = [say('p1', { type: 'text', text: 'One feature, one dev. Here is the envelope.' }, proposePart(false))]
const proposed = [say('p2', { type: 'text', text: 'One feature, one dev. Here is the envelope.' }, proposePart(true))]
const working = [say('s1', { type: 'text', text: 'dev-1 starts on export-markdown.' }, startPart(true))]
const verified = [say('v1', { type: 'text', text: 'export-markdown goes to the judge.' }, verifyPart)]
const together = [
  goal,
  say('t1', { type: 'text', text: 'One feature, one dev. Here is the envelope.' }, proposePart(true)),
  say('t2', { type: 'text', text: 'Approved. dev-1 starts; it goes to the judge once it is done.' }, startPart(true)),
]

export function App() {
  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-6xl flex-col gap-14 px-4 py-10 md:px-8">
        <header className="flex flex-col gap-4">
          <p className="font-brand m-0 text-lg">Agora</p>
          <h1 className="font-brand m-0 text-4xl font-medium tracking-tight">Team view: the assistant-ui pieces</h1>
          <p className="text-muted-foreground m-0 max-w-3xl text-[15px] leading-relaxed">
            One section per thing the person must see or do while a team works. Under each, the assistant-ui pieces that answer it, side by side, on the
            same example. Every piece is the registry’s code, unmodified (checked against the registry on 29 October 2026, @assistant-ui/react 0.15.32),
            shown in fixed states. Nothing is wired: answer buttons do nothing; a lane and the Task tray open, as the elements do.
            <span className="text-primary"> ★</span> marks the piece I suggest.
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
            <span><span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">runtime-bound</span> renders from the tool call itself: nothing to pass</span>
            <span><span className="bg-foreground/[0.06] rounded-full px-2 py-0.5 text-[11px] font-medium">presentational</span> takes props: Agora maps its data onto them</span>
            <span><span className="bg-primary/12 text-primary rounded-full px-2 py-0.5 text-[11px] font-medium">Agora, not assistant-ui</span> Agora’s client already has it</span>
          </div>
          <dl className="bg-muted/40 m-0 grid max-w-3xl grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-xl border px-4 py-3 text-[13px]">
            <dt className="text-muted-foreground">Example</dt><dd className="m-0">{GOAL}</dd>
            <dt className="text-muted-foreground">Feature</dt><dd className="m-0 font-mono text-[12px]">{FEATURE} · {BRANCH}</dd>
            <dt className="text-muted-foreground">Criteria</dt><dd className="m-0">{CRITERIA.join(' · ')}</dd>
            <dt className="text-muted-foreground">Team</dt><dd className="m-0">dev-1, {DEV.harness}; the judge is Agora’s ({JUDGE})</dd>
          </dl>
          <nav className="flex flex-wrap gap-2 text-[13px]">
            {[['approve', '1 · Approve the envelope'], ['member', '2 · See a member work'], ['glance', '3 · See where the team stands'], ['verdict', '4 · Read the verdict'], ['report', '5 · Know what the lead was told'], ['together', 'Together']].map(([id, label]) => (
              <a key={id} href={`#${id}`} className="hover:bg-muted rounded-full border px-3 py-1 no-underline">{label}</a>
            ))}
          </nav>
        </header>

        <Need
          id="approve"
          title="1 · Approve the envelope"
          mechanism={<>assistant-ui models a decision as an <code>approval</code> on the tool call itself: the lead’s <code>propose</code> call carries it, Agora (the host) keeps it open, the person answers it, a receipt stays. The other mechanism, a human tool, makes the answer the call’s result: the lead’s call would stay open until the person answers.</>}
        >
          <Option name="Tool fallback with an approval" kind="bound" item="@assistant-ui/tool-fallback" doc="/elements/tool-fallback"
            gives="The only piece that takes the three answers natively: Approve, Revise with a typed note, Stop. Grants appear on a confirmation step when an option asks for one."
            lacks="The envelope shows only as the call’s raw arguments, so what the person reads must fit in the prompt line; once answered it folds into “1 tool call”.">
            <State label="asking"><FrozenThread messages={proposing} /></State>
            <State label="answered"><FrozenThread messages={proposed} /></State>
          </Option>
          <Option name="Approval card" kind="props" item="@assistant-ui/elements-approval-card" doc="/elements/approval-card" star
            gives="Reads well: title, description, label/value rows for feature, criteria, team, limits; answered, it stays in place as a receipt. Its docs give the recipe that drives it from the call’s approval (see Together)."
            lacks="Two answers, no note. To revise, you write to the lead: a message sent instead of an answer cancels the approval (LocalRuntime’s rule, which Agora would apply).">
            <State label="asking">
              <ApprovalCard state="request" title="Run a team on export-markdown" subtitle="Proposed by the lead · 1 feature · 1 member" description={GOAL} details={DETAILS} allowOnceLabel="Approve" denyLabel="Refuse" onAllowOnce={noop} onDeny={noop} />
            </State>
            <State label="answered">
              <ApprovalCard state="done" title="Run a team on export-markdown" subtitle="Proposed by the lead · 1 feature · 1 member" statusLabel="Approved · envelope v1" />
            </State>
          </Option>
          <Option name="Permission grant" kind="props" item="@assistant-ui/elements-permission-grant" doc="/elements/permission-grant"
            gives="Spells out what a yes allows, line by line: the rights of each member."
            lacks="Answers fixed to Deny, This session, Always (scopes of one capability, not a plan); no room for criteria or limits.">
            <State label="asking"><PermissionGrant capability="Run a team on export-markdown" requester="the lead · claude-code · opus" reach={GRANTS} scope="pending" onGrant={noop} /></State>
            <State label="answered"><PermissionGrant capability="Run a team on export-markdown" requester="the lead · claude-code · opus" reach={GRANTS} scope="session" /></State>
          </Option>
          <Option name="Option list" kind="props" item="@assistant-ui/elements-option-list" doc="/elements/option-list"
            gives="A pick that collapses into a receipt."
            lacks="It is a human tool: the answer is the call’s result, so the lead’s call stays open until you answer (an hour at most). Fits a question the lead asks, not the envelope.">
            <State label="asking"><OptionList options={ENVELOPE_OPTIONS} onConfirm={noop} /></State>
            <State label="answered"><OptionList options={ENVELOPE_OPTIONS} choice={['approve']} /></State>
          </Option>
        </Need>

        <Need
          id="member"
          title="2 · See a member work"
          mechanism={<>A delegated member is a tool call that carries the member’s conversation (<code>ToolCallMessagePart.messages</code>), its status and its timing. Agora’s client fills them from the member’s Workstream in the Agents folder; the pieces below only render them.</>}
        >
          <Option name="Task card lane" kind="bound" item="@assistant-ui/task-card" doc="/elements/task-card" star
            gives="State, elapsed time, label and agent come from the call’s own fields (description, agent); the member’s conversation opens in place, read-only. Click a lane."
            lacks="It assumes the lead waits for its member: while dev-1 works, the lead’s message reads as still running (the dot); marked finished, the lane reads done. Agora’s lead does not wait.">
            <State label="dev-1 works, the lead's turn has ended"><FrozenThread messages={working} lanes /></State>
            <State label="same, the lead's message marked finished"><FrozenThread messages={[{ ...working[0]!, status: { type: 'complete', reason: 'stop' } }]} lanes /></State>
          </Option>
          <Option name="Tool fallback (nothing configured)" kind="bound" item="@assistant-ui/tool-fallback" doc="/elements/tool-fallback"
            gives="What any tool call gets by default."
            lacks="The member’s conversation is not shown; the call is just “start” and its arguments.">
            <FrozenThread messages={working} />
          </Option>
          <Option name="Subagent list" kind="props" item="@assistant-ui/elements-subagent-list" doc="/elements/subagent-list"
            gives="A compact roster of workers and their models."
            lacks="Progress is 0 or 100 % only, no failed state, no conversation to open; assembled by hand from the calls.">
            <SubagentList agents={[{ name: 'dev-1 · Export a Workstream as Markdown', model: 'claude-code · opus' }]} completedCount={0} progress={[0]} showSummary={false} summaryAgent={{ name: '', model: '' }} />
          </Option>
        </Need>

        <Need
          id="glance"
          title="3 · See where the team stands"
          mechanism={<>assistant-ui counts the tasks itself (<code>s.thread.tasks</code>): every tool call that carries a conversation. The two bound pieces read that count from the same thread as section 2.</>}
        >
          <Option name="Task tray" kind="bound" item="@assistant-ui/agent-status" doc="/elements/agent-status" star
            gives="A pill that opens the list of every task with its state; its tally (“3 tasks done, 1 failed”) stays after the work."
            lacks="It counts tasks, not features: what is shippable is Agora’s to say, elsewhere.">
            <FrozenRuntime messages={working}><TaskTray /></FrozenRuntime>
          </Option>
          <Option name="Agent status" kind="bound" item="@assistant-ui/agent-status" doc="/elements/agent-status"
            gives="What runs and since when, in one pill."
            lacks="It disappears once nothing runs: no tally of what was done.">
            <FrozenRuntime messages={working}><AgentStatus /></FrozenRuntime>
          </Option>
          <Option name="Agent plan" kind="props" item="@assistant-ui/elements-agent-plan" doc="/elements/agent-plan"
            gives="A checklist with its progress."
            lacks="Fixed steps; a lead decides as it goes, so the list would be Agora’s team state redrawn by hand.">
            <AgentPlan title="Team" steps={['Envelope approved', 'dev-1 builds export-markdown', 'The judge verifies', 'Done']} activeIndex={1} />
          </Option>
        </Need>

        <Need
          id="verdict"
          title="4 · Read the verdict"
          mechanism={<>The verdict is the <code>verify</code> call’s result; the judge’s run is its nested conversation.</>}
        >
          <Option name="Task card lane, its result" kind="bound" item="@assistant-ui/task-card" doc="/elements/task-card" star
            gives="The verdict sits under the judge’s lane, next to its conversation."
            lacks="Plain text: the checks are not structured.">
            <FrozenThread messages={verified} lanes />
          </Option>
          <Option name="Score breakdown" kind="props" item="@assistant-ui/elements-score-breakdown" doc="/elements/score-breakdown"
            gives="Every check with its evidence, and a verdict pill."
            lacks="Made for weighted scores on one scale: a pass is drawn as a full bar, a fail as an empty one. Registered as verify’s own UI, it replaces the lane.">
            <ScoreBreakdown verdict="Shippable" total={10} outOf={10} criteria={SCORE} visibleCount={4} />
          </Option>
        </Need>

        <Need
          id="report"
          title="5 · Know what the lead was told"
          mechanism={<>When a member finishes, Agora writes the lead’s next turn: a report. For the person, the lane’s change already says it; the question is how much of the report to show.</>}
        >
          <Option name="A notice line" kind="agora" star
            gives="One quiet line between messages, as Agora already shows “Session started”: the lead was told, the lane has the rest."
            lacks="Not assistant-ui: Agora’s notice, extended to reports.">
            <p className="text-muted-foreground m-0 w-full py-3 text-center text-[12px]">Agora told the lead: dev-1 finished its turn on export-markdown.</p>
          </Option>
          <Option name="Speaker identity" kind="props" item="@assistant-ui/elements-speaker-identity" doc="/elements/speaker-identity"
            gives="Who said what, with an icon per kind of speaker."
            lacks="No state colour (a failure reads like a success), no link; it repeats what the lanes show.">
            <SpeakerIdentity turns={[{ id: 'r1', kind: 'subagent', name: 'dev-1', detail: 'claude-code · opus', text: 'Finished export-markdown: draft PR #170, CI green.' }, { id: 'r2', kind: 'subagent', name: 'judge-1', detail: 'codex · gpt-6.1-sol', text: 'PASS on 3f2a91c.' }]} />
          </Option>
        </Need>

        <section id="together" className="flex flex-col gap-4 scroll-mt-6">
          <div className="flex flex-col gap-1">
            <h2 className="font-brand m-0 text-2xl font-medium">Together</h2>
            <p className="text-muted-foreground m-0 max-w-3xl text-[14px] leading-relaxed">The ★ pieces in one thread, and nothing else: the Task tray above it, the Approval card driven by the propose call’s own approval (its documented recipe, with <code>display: "standalone"</code> so the answered card stays out of the tool group), dev-1’s lane running with the dot section 2 explains.</p>
          </div>
          <div className="flex max-w-3xl flex-col gap-3 rounded-xl border p-3.5">
            <FrozenRuntime messages={together}>
              <div className="flex justify-end"><TaskTray /></div>
            </FrozenRuntime>
            <FrozenThread messages={together} lanes config={TOGETHER_CONFIG} />
          </div>
        </section>
      </main>
    </TooltipProvider>
  )
}

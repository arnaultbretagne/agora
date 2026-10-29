// The lead's typed tools, rendered with assistant-ui's elements. `start` and `verify` have no UI here
// in the lanes view: they carry a nested transcript, so Thread's TaskGroup slot renders them.
import {
  AuiConfig,
  defineToolkit,
  Tools,
  useAuiState,
  type ToolApprovalResponse,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react'
import { GlobeIcon, ScrollTextIcon } from 'lucide-react'
import { createContext, useContext, type FC } from 'react'
import { AgentPlan } from '@/components/assistant-ui/elements/agent-plan'
import { ApprovalCard, type ApprovalState } from '@/components/assistant-ui/elements/approval-card'
import { PermissionGrant, type GrantScope } from '@/components/assistant-ui/elements/permission-grant'
import { cn } from '@/lib/utils'
import { FEATURES, PR, prLabel, type Feature, type FeatureId } from '@/data/run'
import type { accessArgs, doneArgs, planArgs } from '@/data/timeline'

export type ApprovalVariant = 'card' | 'grant'
export const ApprovalVariantContext = createContext<ApprovalVariant>('card')

type Approval = ToolCallMessagePartProps['approval']

const answerWith = (respond: ToolCallMessagePartProps['respondToApproval']) => (response: ToolApprovalResponse) => {
  respond(response).catch((failure: unknown) => console.error(failure))
}

/** request → done, as the Approval card reads a gate; the receipt names what was chosen. */
const cardState = (approval: Approval, result: unknown): ApprovalState =>
  approval?.approved === undefined ? 'request' : approval.approved === false ? 'denied' : result === undefined ? 'running' : 'done'

const grantScope = (approval: Approval): GrantScope | 'pending' => {
  if (approval?.approved === undefined) return 'pending'
  if (approval.approved === false) return 'denied'
  return approval.optionId === 'always' ? 'always' : 'session'
}

const memberLine = (m: (typeof planArgs)['team'][number]) =>
  `${m.harness} · ${m.model} · ${m.effort} · ${m.access.map((a) => a.replace('github:arnaultbretagne/', '')).join(', ')}`

const featureLine = (f: Feature) => `${prLabel(f.id as FeatureId)} · ${f.branch} · ${f.criteria.length} criteria`

/** The criteria the person approves with the envelope. Neither element has room for them. */
const Criteria: FC<{ features: Feature[] }> = ({ features }) => (
  <details className="group text-foreground/80 w-full max-w-lg text-xs" data-slot="envelope-criteria">
    <summary className="text-muted-foreground hover:text-foreground cursor-pointer px-1 py-1 select-none">
      Acceptance criteria ({features.reduce((n, f) => n + f.criteria.length, 0)}), under the envelope
    </summary>
    <div className="border-border/60 mt-1 flex flex-col gap-3 rounded-xl border px-3.5 py-3">
      {features.map((f) => (
        <div key={f.id} className="flex flex-col gap-1">
          <span className="font-mono text-[11px] font-medium">{f.id}</span>
          <ol className="text-foreground/70 flex list-none flex-col gap-1 ps-0">
            {f.criteria.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-muted-foreground font-mono text-[11px]">C{i + 1}</span>
                <span>{c}</span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  </details>
)

type PlanArgs = typeof planArgs

const Envelope: FC<ToolCallMessagePartProps<PlanArgs, string>> = ({ args, approval, result, respondToApproval }) => {
  const variant = useContext(ApprovalVariantContext)
  const canAnswer = useAuiState((s) => s.thread.capabilities.answerToolCall)
  const answer = answerWith(respondToApproval)
  const open = canAnswer && approval?.approved === undefined
  const features = args.features ?? []
  const team = args.team ?? []

  if (variant === 'grant') {
    return (
      <div className="flex flex-col gap-2 py-2" data-slot="envelope">
        <PermissionGrant
          className="max-w-lg"
          capability={`Run a team on ${features.length} features`}
          requester="lead · claude-code · opus · high"
          reach={[
            ...features.map((f) => `${f.id} · ${featureLine(f)}`),
            ...team.map((m) => `${m.name} (${m.role}) · ${memberLine(m)}`),
            `judge · ${args.judge}`,
            ...(args.limits ?? []),
          ]}
          scope={grantScope(approval)}
          {...(open && {
            onGrant: (scope: GrantScope) => answer({ optionId: scope === 'denied' ? 'stop' : 'approve' }),
          })}
        />
        <Criteria features={features} />
      </div>
    )
  }

  const state = cardState(approval, result)
  return (
    <div className="flex flex-col gap-2 py-2" data-slot="envelope">
      <ApprovalCard
        className="max-w-lg"
        state={state}
        icon={<ScrollTextIcon className="size-4" />}
        title={args.title ?? 'Plan'}
        subtitle="The lead's envelope · one approval covers the whole run"
        description={args.why}
        details={[
          ...features.map((f) => ({ label: f.id, value: featureLine(f) })),
          ...team.map((m) => ({ label: `${m.name} · ${m.role}`, value: memberLine(m) })),
          { label: 'judge', value: args.judge ?? '' },
          { label: 'limits', value: (args.limits ?? []).join(' · ') },
        ]}
        allowOnceLabel="Approve"
        alwaysAllowLabel="Revise"
        denyLabel="Stop"
        statusLabel={
          state === 'done'
            ? 'Approved · the run started within this envelope'
            : state === 'denied'
              ? approval?.optionId === 'revise'
                ? 'Revise · your note goes back to the lead'
                : 'Stopped · the run ends here'
              : undefined
        }
        {...(open && {
          onAllowOnce: () => answer({ optionId: 'approve' }),
          onAlwaysAllow: () => answer({ optionId: 'revise' }),
          onDeny: () => answer({ optionId: 'stop' }),
        })}
      />
      <Criteria features={features} />
    </div>
  )
}

type AccessArgs = typeof accessArgs

const AccessRequest: FC<ToolCallMessagePartProps<AccessArgs, string>> = ({ args, approval, result, respondToApproval }) => {
  const variant = useContext(ApprovalVariantContext)
  const canAnswer = useAuiState((s) => s.thread.capabilities.answerToolCall)
  const answer = answerWith(respondToApproval)
  const open = canAnswer && approval?.approved === undefined

  if (variant === 'grant') {
    return (
      <div className="py-2">
        <PermissionGrant
          capability={args.access}
          requester={`${args.member} · on ${args.feature}`}
          reach={[args.gives, `${args.member} only, until the run ends`, args.why]}
          scope={grantScope(approval)}
          {...(open && {
            onGrant: (scope: GrantScope) => answer({ optionId: scope === 'denied' ? 'deny' : scope }),
          })}
        />
      </div>
    )
  }

  const state = cardState(approval, result)
  return (
    <div className="py-2">
      <ApprovalCard
        state={state}
        icon={<GlobeIcon className="size-4" />}
        title={`${args.member} asks for ${args.access}`}
        subtitle={`member of this run · claude-code · opus · high · on ${args.feature}`}
        description={args.why}
        details={[
          { label: 'access', value: args.access },
          { label: 'gives', value: args.gives },
          { label: 'for', value: `${args.member} only, until the run ends` },
        ]}
        allowOnceLabel="Grant for this run"
        alwaysAllowLabel="Always"
        denyLabel="Deny"
        statusLabel={state === 'done' ? (approval?.optionId === 'always' ? 'Granted · always' : 'Granted for this run') : undefined}
        {...(open && {
          onAllowOnce: () => answer({ optionId: 'session' }),
          onAlwaysAllow: () => answer({ optionId: 'always' }),
          onDeny: () => answer({ optionId: 'deny' }),
        })}
      />
    </div>
  )
}

type DoneArgs = typeof doneArgs

const Done: FC<ToolCallMessagePartProps<DoneArgs, string>> = ({ args }) => (
  <div className="flex flex-col gap-3 py-2" data-slot="done">
    <AgentPlan
      title="Judged shippable"
      steps={FEATURES.map((f) => ({ id: f.id, label: `${f.id} · ${prLabel(f.id as FeatureId)} at ${PR[f.id as FeatureId].head}` }))}
      activeIndex={FEATURES.length}
    />
    {args.summary && (
      <div className={cn('border-border/60 text-foreground/80 max-w-lg rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed whitespace-pre-line')}>
        <div className="text-muted-foreground mb-1 font-mono text-[11px]">done · summary for you</div>
        {args.summary}
      </div>
    )}
  </div>
)

const Hidden = () => null

const shared = {
  plan: { type: 'backend', display: 'standalone', render: Envelope },
  request_access: { type: 'backend', display: 'standalone', render: AccessRequest },
  done: { type: 'backend', display: 'standalone', render: Done },
} as const

/** Lanes: start and verify stay unregistered, so Thread's TaskGroup slot takes them. */
export const LANES_CONFIG = AuiConfig({ tools: Tools({ toolkit: defineToolkit({ ...shared }) }) })

/** Subagent list: the dispatch tools render nothing; the list under the message owns the visual. */
export const LIST_CONFIG = AuiConfig({
  tools: Tools({
    toolkit: defineToolkit({
      ...shared,
      start: { type: 'backend', display: 'standalone', render: Hidden },
      verify: { type: 'backend', display: 'standalone', render: Hidden },
    }),
  }),
})

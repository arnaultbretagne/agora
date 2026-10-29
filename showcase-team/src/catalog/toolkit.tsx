// The Approval card's "With a runtime" recipe from its docs: the propose call's own approval drives
// the card. Used only in the "Together" thread.
import { AuiConfig, Tools, defineToolkit } from '@assistant-ui/react'
import { ApprovalCard } from '@/components/assistant-ui/elements/approval-card'
import { DETAILS } from './details'

const noop = () => {}

const toolkit = defineToolkit({
  propose: {
    type: 'backend',
    // Outside the tool group, as human-in-the-loop UIs are: the decision stays visible once answered.
    display: 'standalone',
    render: ({ approval, result }) => (
      <ApprovalCard
        state={approval?.approved === false ? 'denied' : approval?.approved === undefined ? 'request' : result === undefined ? 'running' : 'done'}
        title="Run a team on export-markdown"
        subtitle="Proposed by the lead · 1 feature · 1 member"
        details={approval?.approved === undefined ? DETAILS : undefined}
        allowOnceLabel="Approve"
        denyLabel="Refuse"
        statusLabel="Approved · envelope v1"
        onAllowOnce={noop}
        onDeny={noop}
      />
    ),
  },
})

export const TOGETHER_CONFIG = AuiConfig({ tools: Tools({ toolkit }) })

// The marks Agora puts on a prompt's blocks (docs/specs/log.md, "Elements"), beside its catch-up's.

/**
 * Who wrote a message, on its first block, Agora's line (docs/specs/delegation.md, "Messages"). Its value: `{ workstream,
 * as }`, `as` being `delegator`, `delegate` or `agora`, with `turn` on a delegate's.
 */
export const FROM_META = 'agora.bretagne.dev/from'

/** A report of Agora's to a delegate's caller, as earlier delegations wrote it. Its value: `{ delegates }`. */
export const REPORT_META = 'agora.bretagne.dev/report'

/** A delegate's message from its caller, as earlier delegations wrote it. Its value: `{ caller }`. */
export const DELEGATION_META = 'agora.bretagne.dev/delegation'

/**
 * Re-seed builder (ADR 0005: reopening a dormant conversation = spawn a fresh
 * runtime and replay the hub history as context — never `--resume`, never the
 * native transcript).
 *
 * Format: ONE flattened, role-tagged transcript pushed as the first channel
 * message. Reasoning/tool structure never existed in the hub history (the pipe
 * carries whole user-facing turns only, spike S1), so a plain-text replay is
 * lossless by construction.
 */

const MAX_SEED_TURNS = 80

/**
 * @param {{title?: string, messages: Array<{role: string, text: string}>}} conv
 *   history — every persisted turn EXCEPT the new user messages being delivered now
 * @param {Array<{text: string}>} newMessages the not-yet-answered user messages
 */
export function buildSeedContent(conv, history, newMessages) {
  const turns = history.slice(-MAX_SEED_TURNS)
  const omitted = history.length - turns.length
  const transcript = turns
    .map((m) => `[${m.role === 'user' ? 'user' : 'assistant'}] ${m.text}`)
    .join('\n\n')
  const news = newMessages.map((m) => `[user] ${m.text}`).join('\n\n')

  return [
    '[conversation resumed]',
    'This is the continuation of an existing conversation between the user and you on the agora hub',
    `(title: "${conv.title ?? 'untitled'}"). The runtime was re-opened; the prior history, oldest first:`,
    '',
    '<history>',
    omitted > 0 ? `(… ${omitted} earlier turns omitted …)\n` : null,
    transcript,
    '</history>',
    '',
    'The conversation continues. Answer the new user message below in that context,',
    'via the `reply` tool as usual. Do not re-answer history items.',
    '',
    news,
  ]
    .filter((line) => line !== null)
    .join('\n')
}

/**
 * Anchor + delta resume (ADR 0007): the runtime's native session already holds its own context,
 * so a reopen never replays full history — only the hub turns it missed while dormant.
 *
 * @param {Array<{seq: number, id: string, role: string, text: string}>} messages every persisted
 *   message in the conversation
 * @param {number} syncedSeq the hub seq the native session is a faithful copy up to
 * @param {string[]} queuedIds ids already being delivered as the live push — never duplicated
 * @returns {Array<{seq: number, id: string, role: string, text: string}>} the missed turns, oldest first
 */
export function computeDelta({ messages }, syncedSeq, queuedIds) {
  return messages.filter((m) => m.seq > syncedSeq && !queuedIds.includes(m.id))
}

/**
 * The resume counterpart to `buildSeedContent`: pushed only when `computeDelta` is non-empty (an
 * empty delta means plain pushes — the caller's job, not this builder's, per ADR 0007).
 *
 * @param {{title?: string}} conv
 * @param {Array<{role: string, text: string}>} deltaTurns hub turns missed while dormant, oldest first
 * @param {Array<{text: string}>} newMessages the not-yet-answered user messages
 */
export function buildDeltaSeedContent(conv, deltaTurns, newMessages) {
  const missed = deltaTurns
    .map((m) => `[${m.role === 'user' ? 'user' : 'assistant'}] ${m.text}`)
    .join('\n\n')
  const news = newMessages.map((m) => `[user] ${m.text}`).join('\n\n')

  return [
    '[conversation resumed — native session restored]',
    `Your native session for this conversation (title: "${conv.title ?? 'untitled'}") was restored, so`,
    'you already hold the prior context. The turns below happened on the hub while your session was',
    'inactive — read them as context you missed, oldest first:',
    '',
    '<missed-turns>',
    missed,
    '</missed-turns>',
    '',
    'The conversation continues. Answer the new user message below via the `reply` tool as usual.',
    'Do not re-answer missed items.',
    '',
    news,
  ].join('\n')
}

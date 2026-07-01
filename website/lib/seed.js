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

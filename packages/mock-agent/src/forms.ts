// The forms the real adapters ask (docs/specs/log.md, "Requests"), built as they build them, so that the mock agent's
// `/question` and `/form` send what Claude Code and Codex send:
// - claude-agent-acp 0.106.0, `askUserQuestionsToCreateRequest` and `mcpElicitationToCreateRequest` (dist/elicitation.js):
//   AskUserQuestion's questions, each a field `question_<n>` — one option of `oneOf`, or several of an array's
//   `items.anyOf` — with its "Other" companion `question_<n>_custom`, nothing required; and an MCP server's form, as given.
// - codex-acp 2.6.0, `buildUserInputRequest` (src/CodexElicitationHandler.ts): request_user_input's questions, each a
//   field by its id — its options in `oneOf`, "None of the above" added when it takes an own answer, then its note
//   field —, all required, `isOther` and `isSecret` under `_meta.codex`.

type Ask = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }
type CodexQuestion = { id: string; header: string; question: string; isOther: boolean; isSecret: boolean; options: { label: string; description: string }[] | null }

const DATABASE: Ask = {
  question: 'Which database should the service use?',
  header: 'Database',
  multiSelect: false,
  options: [
    { label: 'PostgreSQL', description: 'Managed and durable; the team runs it already' },
    { label: 'SQLite', description: 'One file next to the service' },
  ],
}
const CHECKS: Ask = {
  question: 'Which checks should run before the merge?',
  header: 'Checks',
  multiSelect: true,
  options: [{ label: 'Lint' }, { label: 'Unit tests', description: 'A minute' }, { label: 'Browser tests', description: 'Ten minutes' }],
}

/** AskUserQuestion's questions for `/question`, `/question multi`, `/question several`. */
export const ASKS: Readonly<Record<string, Ask[]>> = { one: [DATABASE], multi: [CHECKS], several: [DATABASE, CHECKS] }

/** As claude-agent-acp's `askUserQuestionsToCreateRequest`, for a client that is not JetBrains AIR. */
export function askUserQuestion(questions: Ask[], sessionId: string, toolCallId: string): Record<string, unknown> {
  const single = questions.length === 1
  const properties: Record<string, unknown> = {}
  questions.forEach((question, index) => {
    const options = question.options.map((o) => ({ const: o.label, title: o.label, ...(o.description ? { description: o.description } : {}) }))
    const description = single ? undefined : question.question
    const title = question.header || undefined
    properties[`question_${String(index)}`] = question.multiSelect ? { type: 'array', title, description, items: { anyOf: options } } : { type: 'string', title, description, oneOf: options }
    properties[`question_${String(index)}_custom`] = {
      type: 'string',
      title: 'Other',
      description: question.multiSelect ? 'Type your own answer to add to your selection above (optional).' : 'Type your own answer, or add a note to the option you chose above (optional).',
    }
  })
  // Undefined members are not written, as JSON.stringify leaves them out of the line.
  return { mode: 'form', sessionId, toolCallId, message: single ? questions[0]!.question : 'Please answer the following questions.', requestedSchema: { type: 'object', properties } }
}

/** The title Claude Code's AskUserQuestion line takes (tool-calls/reporters/interaction.js): the question when there is one. */
export const askTitle = (questions: Ask[]): string => (questions.length === 1 ? questions[0]!.question : 'Asking for your input')

/** An MCP server's form as Claude Code forwards it (`mcpElicitationToCreateRequest`): a number and a yes/no, for `/question mcp`. */
export const mcpForm = (sessionId: string): Record<string, unknown> => ({
  mode: 'form',
  sessionId,
  message: 'How should the rollout go?',
  requestedSchema: {
    type: 'object',
    properties: {
      replicas: { type: 'integer', title: 'Replicas', description: 'How many to run', minimum: 1, maximum: 5 },
      canary: { type: 'boolean', title: 'Canary first' },
    },
    required: ['replicas'],
  },
})

const ENVIRONMENT: CodexQuestion = {
  id: 'environment',
  header: 'Environment',
  question: 'Which environment should I deploy to?',
  isOther: true,
  isSecret: false,
  options: [
    { label: 'Staging', description: 'The preview cluster' },
    { label: 'Production', description: '' },
  ],
}
const BRANCH: CodexQuestion = { id: 'branch', header: 'Branch', question: 'Which branch should the release start from?', isOther: false, isSecret: false, options: null }
const TOKEN: CodexQuestion = { id: 'token', header: 'Token', question: 'Paste the deploy token.', isOther: false, isSecret: true, options: null }

/** request_user_input's questions for `/form`, `/form text`, `/form secret`, `/form several`. */
export const QUESTIONS: Readonly<Record<string, CodexQuestion[]>> = { one: [ENVIRONMENT], text: [BRANCH], secret: [TOKEN], several: [ENVIRONMENT, BRANCH] }

/** As codex-acp's `buildUserInputRequest`, for a client that is not JetBrains AIR. */
export function requestUserInput(questions: CodexQuestion[], sessionId: string, itemId: string, autoResolutionMs: number | null = null): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const ids = new Set(questions.map((q) => q.id))
  for (const question of questions) {
    const options = question.options ?? []
    const other = question.isOther && options.length > 0
    const base = {
      title: question.question || question.header || question.id,
      ...(question.header ? { description: question.header } : {}),
      _meta: { codex: { isOther: question.isOther, isSecret: question.isSecret } },
    }
    properties[question.id] =
      options.length > 0
        ? {
            ...base,
            type: 'string',
            oneOf: [
              ...options.map((o) => ({ const: o.label, title: o.label, ...(o.description ? { description: o.description } : {}) })),
              ...(other ? [{ const: 'None of the above', title: 'None of the above', description: 'Provide a different answer in the note field.' }] : []),
            ],
          }
        : { ...base, type: 'string' }
    if (other) {
      let note = `${question.id}_note`
      for (let i = 1; ids.has(note); i++) note = `${question.id}_note${String(i)}`
      properties[note] = { type: 'string', title: 'Additional answer or note', _meta: { codex: { questionId: question.id, role: 'user_note', isSecret: question.isSecret } } }
    }
  }
  return {
    sessionId,
    toolCallId: itemId,
    mode: 'form',
    message: 'Codex needs your input to continue.',
    requestedSchema: { type: 'object', properties, required: questions.map((q) => q.id) },
    _meta: { codex: { autoResolutionMs } },
  }
}

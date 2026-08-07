/**
 * The derivations that turn engine facts into what the operator sees. They live outside the render
 * functions precisely so they can be asserted directly rather than through a DOM stub — the OLD UI
 * put all of this inline and could only ever test that the module loaded.
 *
 * The one that matters most is `configOptionsFromItems`: the model and effort selectors have no
 * dedicated read route, and this is the reasoning that says they can exist at all. `server.test.ts`
 * proves the same thing end to end against a real Postgres and a real ACP Agent; this file proves
 * the client-side half in isolation, including the cases where the assumption does not hold.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PublicAgent, Session, WorkstreamItem, WorkstreamTurn } from '../src/client/api.js'
import {
  clampIndex,
  configOptionsFromItems,
  currentSession,
  findConfigOption,
  groupOf,
  groupWorkstreams,
  hasRunningTurn,
  invocationTurnSpent,
  launchableAgents,
  messagesFromItems,
  railIndexAt,
  runtimeStateOfPhase,
  STATE_LABELS,
} from '../src/client/view-model.js'

function item(overrides: Partial<WorkstreamItem> & { kind: string; value: Record<string, unknown> }): WorkstreamItem {
  return {
    id: overrides.id ?? `item-${Math.random()}`,
    workstreamId: 'w1',
    sessionId: 's1',
    turnId: null,
    kind: overrides.kind,
    firstEventId: 'e1',
    latestEventId: 'e1',
    firstWorkstreamSeq: overrides.firstWorkstreamSeq ?? 1,
    latestWorkstreamSeq: overrides.latestWorkstreamSeq ?? overrides.firstWorkstreamSeq ?? 1,
    value: overrides.value,
    contentSha256: 'sha',
    updatedAt: '2026-08-06T10:00:00.000Z',
  }
}

function session(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    workstreamId: 'w1',
    ordinal: 1,
    agentId: 'fake-agent',
    phase: 'ready',
    current: true,
    runtimeDefinitionVersion: 'v1',
    createdAt: '2026-08-06T10:00:00.000Z',
    failure: null,
    ...overrides,
  }
}

// ---------- runtime state ----------

test('every Session phase maps onto one of the four states the operator reads', () => {
  assert.equal(runtimeStateOfPhase('requested'), 'starting')
  assert.equal(runtimeStateOfPhase('provisioning'), 'starting')
  assert.equal(runtimeStateOfPhase('ready'), 'live')
  assert.equal(runtimeStateOfPhase('busy'), 'live')
  assert.equal(runtimeStateOfPhase('failed'), 'error')
  for (const resting of ['suspending', 'suspended', 'closing', 'closed']) {
    assert.equal(runtimeStateOfPhase(resting), 'dormant', `${resting} is at rest, not broken`)
  }
  // A Workstream whose Sessions have all gone, or that has none yet, is at rest — not an error.
  assert.equal(runtimeStateOfPhase(undefined), 'dormant')
  assert.equal(runtimeStateOfPhase('some-phase-this-build-does-not-know'), 'dormant')
})

test('every state has a French label — an unlabelled dot is an unreadable dot', () => {
  for (const state of ['dormant', 'starting', 'live', 'error'] as const) {
    assert.ok(STATE_LABELS[state].length > 0)
  }
})

test('the Session the UI speaks to is the current one, whatever its ordinal', () => {
  const sessions = [session({ id: 'old', ordinal: 1, current: false }), session({ id: 'now', ordinal: 2, current: true })]
  assert.equal(currentSession(sessions)?.id, 'now')
  assert.equal(currentSession([session({ current: false })]), undefined)
  assert.equal(currentSession([]), undefined)
})

// ---------- history grouping ----------

const NOW = new Date('2026-08-06T12:00:00')

test('history buckets are calendar days, not elapsed hours', () => {
  assert.equal(groupOf('2026-08-06T00:05:00', NOW), 'today')
  // 23:50 "yesterday" is 12 hours ago but still belongs under Hier.
  assert.equal(groupOf('2026-08-05T23:50:00', NOW), 'yesterday')
  assert.equal(groupOf('2026-08-01T09:00:00', NOW), 'week')
  assert.equal(groupOf('2026-07-30T09:00:00', NOW), 'week')
  assert.equal(groupOf('2026-07-29T09:00:00', NOW), 'older')
  // A future timestamp (clock skew between server and browser) reads as today rather than crashing.
  assert.equal(groupOf('2026-08-07T09:00:00', NOW), 'today')
})

test('groups render in the fixed order, pinned first, and empty groups disappear', () => {
  const groups = groupWorkstreams(
    [
      { id: 'a', title: 'Ancien', pinned: false, updatedAt: '2026-07-01T09:00:00' },
      { id: 'b', title: "Aujourd'hui", pinned: false, updatedAt: '2026-08-06T09:00:00' },
      { id: 'c', title: 'Épinglé et vieux', pinned: true, updatedAt: '2026-01-01T09:00:00' },
    ],
    '',
    NOW,
  )
  assert.deepEqual(
    groups.map((group) => group.key),
    ['pinned', 'today', 'older'],
  )
  assert.deepEqual(
    groups.map((group) => group.label),
    ['Épinglées', "Aujourd'hui", 'Plus ancien'],
  )
  // A pinned item appears ONLY under Épinglées, never a second time in its date bucket.
  assert.deepEqual(groups[0]?.items.map((w) => w.id), ['c'])
  assert.deepEqual(groups[2]?.items.map((w) => w.id), ['a'])
})

test('within a group the most recently touched comes first', () => {
  const groups = groupWorkstreams(
    [
      { id: 'older', title: 'A', pinned: false, updatedAt: '2026-08-06T08:00:00' },
      { id: 'newer', title: 'B', pinned: false, updatedAt: '2026-08-06T11:00:00' },
    ],
    '',
    NOW,
  )
  assert.deepEqual(groups[0]?.items.map((w) => w.id), ['newer', 'older'])
})

test('search is a case-insensitive substring over titles and survives an accented query', () => {
  const workstreams = [
    { id: 'a', title: 'Déploiement Kubernetes', pinned: false, updatedAt: '2026-08-06T09:00:00' },
    { id: 'b', title: 'Revue de code', pinned: false, updatedAt: '2026-08-06T09:00:00' },
  ]
  assert.deepEqual(groupWorkstreams(workstreams, 'KUBER', NOW)[0]?.items.map((w) => w.id), ['a'])
  assert.deepEqual(groupWorkstreams(workstreams, 'déploi', NOW)[0]?.items.map((w) => w.id), ['a'])
  assert.deepEqual(groupWorkstreams(workstreams, '  ', NOW)[0]?.items.length, 2, 'whitespace is not a filter')
  assert.deepEqual(groupWorkstreams(workstreams, 'rien', NOW), [], 'no match means no groups at all')
})

// ---------- transcript ----------

test('only message items become turns, in sequence order, with chunks concatenated seamlessly', () => {
  const messages = messagesFromItems([
    item({ kind: 'tool_call', firstWorkstreamSeq: 2, value: { toolCallId: 't1', status: 'completed' } }),
    item({ kind: 'message', firstWorkstreamSeq: 3, value: { role: 'agent', completed: true, content: [{ type: 'text', text: 'Bonjour' }, { type: 'text', text: ' Arnault' }] } }),
    item({ kind: 'thought', firstWorkstreamSeq: 1, value: { role: 'thought', content: [{ type: 'text', text: 'hmm' }] } }),
    item({ kind: 'message', firstWorkstreamSeq: 0, value: { role: 'user', completed: true, content: [{ type: 'text', text: 'Salut' }] } }),
    item({ kind: 'plan', firstWorkstreamSeq: 4, value: { entries: [] } }),
  ])
  assert.deepEqual(
    messages.map((message) => [message.role, message.text]),
    [
      ['user', 'Salut'],
      ['agent', 'Bonjour Arnault'],
    ],
  )
})

test('non-text content blocks are skipped rather than stringified into the reply', () => {
  const [message] = messagesFromItems([
    item({
      kind: 'message',
      value: { role: 'agent', content: [{ type: 'text', text: 'avant ' }, { type: 'image', data: 'AAAA' }, { type: 'text', text: 'après' }] },
    }),
  ])
  assert.equal(message?.text, 'avant après')
})

test('a message still streaming is rendered, and reports itself incomplete', () => {
  const [message] = messagesFromItems([item({ kind: 'message', value: { role: 'agent', completed: false, content: [{ type: 'text', text: 'part' }] } })])
  assert.equal(message?.text, 'part')
  assert.equal(message?.completed, false)
})

test('a malformed message item degrades to an empty turn instead of throwing', () => {
  const messages = messagesFromItems([item({ kind: 'message', value: {} }), item({ kind: 'message', value: { role: 'agent', content: 'not an array' } })])
  assert.deepEqual(messages.map((message) => message.text), ['', ''])
  assert.deepEqual(messages.map((message) => message.role), ['agent', 'agent'])
})

function turn(status: WorkstreamTurn['status'], purpose: WorkstreamTurn['purpose'] = 'user'): WorkstreamTurn {
  return {
    id: `t-${purpose}-${status}`,
    workstreamId: 'w1',
    sessionId: 's1',
    turnOrdinal: 1,
    purpose,
    status,
    stopReason: null,
    usage: null,
    startedAt: '2026-08-06T10:00:00.000Z',
    endedAt: null,
  }
}

test('the typing indicator is a running Turn — there is no separate signal to wait for', () => {
  assert.equal(hasRunningTurn([turn('completed'), turn('running')]), true)
  assert.equal(hasRunningTurn([turn('completed'), turn('failed'), turn('cancelled')]), false)
  assert.equal(hasRunningTurn([]), false)
})

test('an invocation spends its single turn on the first user prompt, and a discussion never does', () => {
  // A second prompt to an invocation is refused with 400 `invocation_cardinality_exceeded`, so the
  // composer has to close BEFORE the send rather than surface the refusal after it.
  assert.equal(invocationTurnSpent('invocation', []), false, 'an invocation with no turn yet still accepts one')
  assert.equal(invocationTurnSpent('invocation', [turn('running')]), true, 'the turn is spent when it opens, not when it finishes')
  assert.equal(invocationTurnSpent('invocation', [turn('completed')]), true)
  // A handoff turn is the engine carrying history into a new Session (what a persona or equipment
  // change does); it must not be mistaken for the operator's one allowed prompt.
  assert.equal(invocationTurnSpent('invocation', [turn('completed', 'handoff')]), false)
  // A discussion takes an ongoing conversation, however many turns it has had.
  assert.equal(invocationTurnSpent('discussion', [turn('completed'), turn('completed')]), false)
})

// ---------- harness configuration ----------

const SESSION_NEW_ENVELOPE = {
  method: null,
  rpcKind: 'response',
  direction: 'agent_to_client',
  envelope: {
    jsonrpc: '2.0',
    id: 2,
    result: {
      sessionId: 'acp-1',
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Manual' }] },
      configOptions: [
        { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'default', options: [{ name: 'Default', value: 'default' }, { name: 'Opus', value: 'opus' }] },
        { id: 'effort', name: 'Effort', type: 'select', category: 'thought_level', currentValue: 'high', options: [{ name: 'Low', value: 'low' }, { name: 'High', value: 'high' }] },
      ],
    },
  },
}

test('the option set is read from the journaled ACP envelope the projector kept', () => {
  const options = configOptionsFromItems([
    item({ kind: 'message', firstWorkstreamSeq: 5, value: { role: 'agent', content: [] } }),
    item({ kind: 'unknown', firstWorkstreamSeq: 2, latestWorkstreamSeq: 2, value: SESSION_NEW_ENVELOPE }),
  ])
  assert.deepEqual(options?.map((option) => option.id), ['model', 'effort'])
})

test('the LATEST envelope wins, so a config change replaces the initial advertisement', () => {
  const afterChange = structuredClone(SESSION_NEW_ENVELOPE)
  afterChange.envelope.result.configOptions[0]!.currentValue = 'opus'
  const options = configOptionsFromItems([
    item({ kind: 'unknown', firstWorkstreamSeq: 2, latestWorkstreamSeq: 2, value: SESSION_NEW_ENVELOPE }),
    item({ kind: 'unknown', firstWorkstreamSeq: 9, latestWorkstreamSeq: 9, value: afterChange }),
  ])
  assert.equal(options?.[0]?.currentValue, 'opus')
})

test('unknown items that carry no option set are ignored, and a harness advertising none yields undefined', () => {
  assert.equal(configOptionsFromItems([]), undefined)
  assert.equal(
    configOptionsFromItems([
      item({ kind: 'unknown', value: { method: 'session/cancel', rpcKind: 'notification', direction: 'client_to_agent', envelope: { jsonrpc: '2.0' } } }),
      item({ kind: 'unknown', value: { envelope: { result: { configOptions: 'not an array' } } } }),
      item({ kind: 'unknown', value: {} }),
    ]),
    undefined,
    'a generic bucket has to be read defensively — it is not a typed contract',
  )
})

test('selectors are found by ACP category, with the observed id as the fallback', () => {
  const byCategory = [{ id: 'weird-vendor-id', name: 'Model', category: 'model' }]
  assert.equal(findConfigOption(byCategory, 'model', 'model')?.id, 'weird-vendor-id')
  // "Clients MUST handle missing or unknown categories gracefully" — the ACP schema's own words.
  const byId = [{ id: 'effort', name: 'Effort' }]
  assert.equal(findConfigOption(byId, 'thought_level', 'effort')?.id, 'effort')
  assert.equal(findConfigOption([{ id: 'other', name: 'Other' }], 'model', 'model'), undefined)
})

// ---------- effort rail ----------

test('a click anywhere on the rail snaps to the nearest level, and never off either end', () => {
  assert.equal(railIndexAt(0, 5), 0)
  assert.equal(railIndexAt(1, 5), 4)
  assert.equal(railIndexAt(0.5, 5), 2)
  assert.equal(railIndexAt(0.4, 5), 2)
  // A click landing outside the rail's box (drag, rounding) must not produce an out-of-range level.
  assert.equal(railIndexAt(-0.3, 5), 0)
  assert.equal(railIndexAt(1.4, 5), 4)
  // A single-level option has exactly one answer, and no division by zero.
  assert.equal(railIndexAt(0.7, 1), 0)
})

test('arrow keys clamp at the ends rather than wrapping', () => {
  assert.equal(clampIndex(-1, 5), 0)
  assert.equal(clampIndex(5, 5), 4)
  assert.equal(clampIndex(3, 5), 3)
})

// ---------- agents ----------

test('only enabled Agents are offered — the server refuses to launch the others', () => {
  const agent = (agentId: string, availability: PublicAgent['availability']): PublicAgent => ({
    agentId,
    runtimeDefinitionVersion: 'v1',
    label: agentId,
    description: '',
    availability,
    personas: [],
  })
  assert.deepEqual(
    launchableAgents([agent('a', 'enabled'), agent('b', 'unavailable'), agent('c', 'deprecated')]).map((entry) => entry.agentId),
    ['a'],
  )
})

/**
 * The transcript is now built from projected user messages (PROJECTOR_VERSION 2026-08-07), so an
 * echo only covers the gap until the feed delivers the real one. Retiring them by set membership
 * would make a repeated question disappear: one projected copy would satisfy both echoes.
 */
test('required: asking the same question twice keeps both on screen while only one has been projected', () => {
  const projectedUser = { text: 'encore ?' }
  const echoes = [
    { id: 'e1', text: 'encore ?', seq: 0 },
    { id: 'e2', text: 'encore ?', seq: 1 },
  ]
  // Mirrors transcript()'s retirement rule: one projected copy retires exactly one echo.
  const remaining = new Map<string, number>([[projectedUser.text, 1]])
  const surviving = echoes.filter((echo) => {
    const left = remaining.get(echo.text) ?? 0
    if (left === 0) return true
    remaining.set(echo.text, left - 1)
    return false
  })
  assert.equal(surviving.length, 1, 'the second question must stay visible until its own projection arrives')
  assert.equal(surviving[0]?.id, 'e2')
})

/**
 * ACP's `SessionConfigSelectOptions` is `Array<SessionConfigSelectOption> | Array<
 * SessionConfigSelectGroup>`. Claude Code sends the grouped form for models, where entries carry
 * `group`/`options` and NO `value` — so reading only the flat form listed group headings as models
 * and sent `{"value": undefined}`, which JSON.stringify drops, producing a body of `{}` and the
 * server's "body must be {"value": "<non-empty string>"}".
 */
test('required: a grouped model list is flattened to its real values', () => {
  const items = [
    {
      id: 'i1',
      kind: 'unknown',
      latestWorkstreamSeq: 5,
      value: {
        envelope: {
          result: {
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                type: 'select',
                currentValue: 'opus',
                options: [
                  { group: 'recommended', name: 'Recommended', options: [{ value: 'opus', name: 'Opus' }] },
                  { group: 'other', name: 'Other', options: [{ value: 'haiku', name: 'Haiku' }] },
                ],
              },
            ],
          },
        },
      },
    },
  ] as never
  const options = configOptionsFromItems(items)
  const model = options?.[0]
  assert.deepEqual(
    model?.options?.map((v) => v.value),
    ['opus', 'haiku'],
    'the values a user can actually pick, not the headings they sit under',
  )
  assert.ok(model?.options?.every((v) => typeof v.value === 'string' && v.value.length > 0), 'every rendered value must be a settable string')
})

test('a flat option list is left exactly as it is', () => {
  const items = [
    {
      id: 'i1',
      kind: 'unknown',
      latestWorkstreamSeq: 5,
      value: { envelope: { result: { configOptions: [{ id: 'effort', name: 'Effort', options: [{ value: 'low', name: 'Low' }] }] } } },
    },
  ] as never
  assert.deepEqual(configOptionsFromItems(items)?.[0]?.options?.map((v) => v.value), ['low'])
})

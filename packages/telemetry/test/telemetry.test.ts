import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ALLOWED_FIELDS, buildLogLine, createLogger, errorClass, formatLogLine, Metrics, METRIC } from '../src/index.js'

/** The things that must never reach a log line, in the shapes they actually arrive in. */
const SENSITIVE = {
  prompt: 'Please refactor the billing module; the customer is ACME and their account number is 4029-1123',
  toolResult: 'file contents: BEGIN RSA PRIVATE KEY …',
  bearer: 'Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
  queryString: 'https://api.example/v1/models?api_key=aoc_secretvaluehere&trace=1',
  saveBytes: '{"type":"user","sessionId":"ctx-1","message":{"content":"the codeword is MIRABELLE"}}',
  credential: '{"access_token":"gho_1234567890abcdefghijklmnopqrstuvwxyz"}',
}

test('redaction: none of the sensitive shapes survives a log line, whatever field name carries it', () => {
  const written: string[] = []
  const logger = createLogger((line) => written.push(line))

  // Every sensitive value, under every plausible field name someone might reach for.
  for (const [name, value] of Object.entries(SENSITIVE)) {
    logger.info('prompt.dispatched', { [name]: value, message: value, detail: value, error: value, payload: value, text: value })
    logger.warn('owner.failed', { reason: value, body: value, url: value })
    logger.error('verb.failed', { stack: value, cause: value })
  }

  const output = written.join('\n')
  for (const value of Object.values(SENSITIVE)) {
    assert.ok(!output.includes(value), `a sensitive value reached the log: ${value.slice(0, 40)}…`)
  }
  // And the fragments, not just whole values: a partial leak is a leak.
  for (const fragment of ['sk-ant-api03', 'aoc_secret', 'gho_1234567890', 'MIRABELLE', 'ACME', 'RSA PRIVATE KEY']) {
    assert.ok(!output.includes(fragment), `a sensitive fragment reached the log: ${fragment}`)
  }
  assert.ok(written.every((line) => line.includes('droppedFields')), 'and each line says how many fields it refused')
})

test('the allow list is what passes — nothing else, however innocuous it looks', () => {
  const line = buildLogLine('info', 'verb.executed', {
    workstream: 'ws-1',
    verb: 'START',
    rule: 'SESSION-003',
    outcome: 'ok',
    durationMs: 42,
    // Not registered: dropped, not sanitized. A denylist would have to judge these; this does not.
    promptText: 'anything at all',
    debug: { nested: 'object' },
  })

  assert.deepEqual(line.fields, { workstream: 'ws-1', verb: 'START', rule: 'SESSION-003', outcome: 'ok', durationMs: 42 })
  assert.equal(line.dropped, 2)
  assert.equal(formatLogLine(line), '{"level":"info","event":"verb.executed","workstream":"ws-1","verb":"START","rule":"SESSION-003","outcome":"ok","durationMs":42,"droppedFields":2}')
})

test('an allowed field holding something enormous is truncated: volume is a leak too', () => {
  const line = buildLogLine('info', 'x', { target: 'a'.repeat(5_000) })
  assert.ok(String(line.fields.target).length <= 201)
  assert.ok(String(line.fields.target).endsWith('…'))
})

test('the correlation set is exactly what execution.md names, and nothing has crept in', () => {
  // A field added to this list is a decision about what may be written down forever; the test
  // exists so that decision is deliberate rather than incidental.
  assert.deepEqual([...ALLOWED_FIELDS].sort(), [
    'actor',
    'command',
    'count',
    'durationMs',
    'errorClass',
    'harness',
    'incarnation',
    'outcome',
    'revision',
    'rule',
    'session',
    'target',
    'verb',
    'workstream',
  ])
})

test('errorClass reports the class, never the message', () => {
  assert.equal(errorClass(Object.assign(new Error('bearer sk-ant-secret leaked here'), { code: 'capture_refused' })), 'capture_refused')
  assert.equal(errorClass(new TypeError('https://host/path?api_key=aoc_secret')), 'TypeError')
  assert.equal(errorClass('a bare string with a token gho_123'), 'unknown')
})

test('metrics render as stable Prometheus text with closed-vocabulary labels', () => {
  const metrics = new Metrics()
  metrics.increment(METRIC.evaluations, 'Rule evaluations by rule and result', { rule: 'SESSION-003', result: 'ACTION' })
  metrics.increment(METRIC.evaluations, 'Rule evaluations by rule and result', { rule: 'SESSION-003', result: 'ACTION' })
  metrics.increment(METRIC.evaluations, 'Rule evaluations by rule and result', { rule: 'CONVERGE-001', result: 'CONVERGED' })
  metrics.set(METRIC.unresolvedObligations, 'Retirement obligations not yet discharged', 2)

  const rendered = metrics.render()
  assert.match(rendered, /# TYPE agora_engine_evaluations_total counter/)
  assert.match(rendered, /agora_engine_evaluations_total\{result="ACTION",rule="SESSION-003"\} 2/)
  assert.match(rendered, /agora_engine_evaluations_total\{result="CONVERGED",rule="CONVERGE-001"\} 1/)
  assert.match(rendered, /agora_unresolved_retirement_obligations 2/)
  assert.equal(metrics.render(), rendered, 'rendering is stable, so two scrapes diff readably')
})

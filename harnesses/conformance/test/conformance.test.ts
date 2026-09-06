// The suite tested against a controllable stub harness: a conformance suite that only ever ran
// against a compliant peer would never prove it can FAIL. Each case makes the stub violate exactly
// one required behavior and asserts the suite reports that specific row as not answered.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as acp from '@agentclientprotocol/sdk'
import type { DuplexByteStream } from '@agora/acp'
import { runConformance, rowReportFor } from '../src/run.js'
import type { ConformanceTarget } from '../src/target.js'

interface StubOptions {
  readonly protocolVersion?: number
  readonly loadSession?: boolean
  readonly sessionCapabilities?: Record<string, unknown>
  readonly configOptions?: acp.SessionConfigOption[]
  /** When false, a set_config_option for an unadvertised value is silently accepted (a violation). */
  readonly refuseUnsupportedValues?: boolean
  readonly listEmptyContexts?: boolean
}

function selectOption(id: string, currentValue: string, values: readonly string[]): acp.SessionConfigOption {
  return { id, name: id, type: 'select', currentValue, options: values.map((value) => ({ value, name: value })) }
}

/** One stub process, many connections — the same shape a real harness bridge guarantees. */
function stubHarness(options: StubOptions = {}): { readonly target: ConformanceTarget; readonly close: () => void } {
  const sessions = new Map<string, { model: string; effort: string; hasContent: boolean }>()
  const agentApp = acp.agent({ name: 'stub-harness' })
  agentApp.onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: options.protocolVersion ?? acp.PROTOCOL_VERSION,
    agentInfo: { name: 'stub-harness', version: '9.9.9' },
    agentCapabilities: {
      loadSession: options.loadSession ?? true,
      sessionCapabilities: options.sessionCapabilities ?? { resume: {}, list: {} },
    },
  }))
  agentApp.onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `stub-${String(sessions.size + 1)}`
    sessions.set(sessionId, { model: 'model-a', effort: 'default', hasContent: false })
    return {
      sessionId,
      configOptions:
        options.configOptions ?? [selectOption('model', 'model-a', ['model-a', 'model-b']), selectOption('effort', 'default', ['default', 'high'])],
    }
  })
  agentApp.onRequest(acp.methods.agent.session.list, () => ({
    sessions: [...sessions.entries()]
      .filter(([, state]) => state.hasContent || options.listEmptyContexts === true)
      .map(([sessionId]) => ({ sessionId, cwd: '/workspace' })),
  }))
  agentApp.onRequest(acp.methods.agent.session.resume, ({ params }) => {
    const { sessionId } = params as { sessionId: string }
    const state = sessions.get(sessionId)
    if (state === undefined) throw new Error(`no such session ${sessionId}`)
    return { configOptions: [selectOption('model', state.model, ['model-a', 'model-b']), selectOption('effort', state.effort, ['default', 'high'])] }
  })
  agentApp.onRequest(acp.methods.agent.session.load, ({ params }) => {
    const { sessionId } = params as { sessionId: string }
    if (!sessions.has(sessionId)) throw new Error(`no such session ${sessionId}`)
    return {}
  })
  agentApp.onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    const { sessionId, configId, value } = params as { sessionId: string; configId: string; value: string }
    const state = sessions.get(sessionId)
    if (state === undefined) throw new Error(`no such session ${sessionId}`)
    const advertised = configId === 'model' ? ['model-a', 'model-b'] : ['default', 'high']
    if (!advertised.includes(value)) {
      if (options.refuseUnsupportedValues === false) {
        // The violation this check exists for: silently keep the old value and report success.
        return { configOptions: [selectOption('model', state.model, ['model-a', 'model-b']), selectOption('effort', state.effort, ['default', 'high'])] }
      }
      throw new Error(`unsupported value ${value} for ${configId}`)
    }
    if (configId === 'model') state.model = value
    else state.effort = value
    return { configOptions: [selectOption('model', state.model, ['model-a', 'model-b']), selectOption('effort', state.effort, ['default', 'high'])] }
  })
  agentApp.onNotification(acp.methods.agent.session.cancel, () => {})

  const connections: { close: () => void }[] = []
  const target: ConformanceTarget = {
    harnessId: 'stub',
    expected: { adapterName: 'stub-harness', adapterVersion: '9.9.9' },
    workspaceRoot: '/workspace',
    connect: async () => {
      const aToB = new TransformStream<Uint8Array, Uint8Array>()
      const bToA = new TransformStream<Uint8Array, Uint8Array>()
      const clientStream: DuplexByteStream = { writable: aToB.writable, readable: bToA.readable }
      const agentStream: DuplexByteStream = { writable: bToA.writable, readable: aToB.readable }
      const connection = agentApp.connect(acp.ndJsonStream(agentStream.writable, agentStream.readable))
      connections.push({ close: () => connection.close?.() })
      return { stream: clientStream, close: async () => connection.close?.() }
    },
  }
  return { target, close: () => connections.forEach((connection) => connection.close()) }
}

test('a compliant stub answers launch/identity, configuration and delivery', async () => {
  const stub = stubHarness()
  try {
    const report = await runConformance(stub.target)
    assert.equal(report.failed, 0, JSON.stringify(report.rows, null, 2))
    assert.equal(rowReportFor(report, 'launch-and-identity')?.answered, true)
    assert.equal(rowReportFor(report, 'configuration-and-bootstrap')?.answered, true)
    assert.equal(rowReportFor(report, 'quiescence-and-delivery')?.answered, true)
  } finally {
    stub.close()
  }
})

test('a harness missing loadSession fails identity — recovery evidence could not exist for it', async () => {
  const stub = stubHarness({ loadSession: false })
  try {
    const report = await runConformance(stub.target)
    const identity = rowReportFor(report, 'launch-and-identity')
    assert.equal(identity?.answered, false)
    const capabilities = identity?.results.find((result) => result.id === 'identity/required-capabilities')
    assert.equal(capabilities?.status, 'fail')
    assert.match(capabilities?.detail ?? '', /loadSession/)
  } finally {
    stub.close()
  }
})

test('a harness missing sessionCapabilities.list fails identity — START could not discover anything', async () => {
  const stub = stubHarness({ sessionCapabilities: { resume: {} } })
  try {
    const report = await runConformance(stub.target)
    const capabilities = rowReportFor(report, 'launch-and-identity')?.results.find((result) => result.id === 'identity/required-capabilities')
    assert.equal(capabilities?.status, 'fail')
    assert.match(capabilities?.detail ?? '', /sessionCapabilities\.list/)
  } finally {
    stub.close()
  }
})

test('a harness that silently substitutes a default instead of refusing fails configuration', async () => {
  const stub = stubHarness({ refuseUnsupportedValues: false })
  try {
    const report = await runConformance(stub.target)
    const configuration = rowReportFor(report, 'configuration-and-bootstrap')
    assert.equal(configuration?.answered, false)
    const substitution = configuration?.results.find((result) => result.id === 'config/no-substituted-default')
    assert.equal(substitution?.status, 'fail')
    assert.match(substitution?.detail ?? '', /substituted|never advertised/)
  } finally {
    stub.close()
  }
})

test('a wrong negotiated protocol version fails identity', async () => {
  const stub = stubHarness({ protocolVersion: 42 })
  try {
    const report = await runConformance(stub.target)
    const version = rowReportFor(report, 'launch-and-identity')?.results.find((result) => result.id === 'identity/protocol-version')
    assert.equal(version?.status, 'fail')
  } finally {
    stub.close()
  }
})

test('an empty context that IS listed turns the discovery hole into a pass', async () => {
  const stub = stubHarness({ listEmptyContexts: true })
  try {
    const report = await runConformance(stub.target)
    const discovery = rowReportFor(report, 'launch-and-identity')?.results.find((result) => result.id === 'discovery/empty-context-is-listed')
    assert.equal(discovery?.status, 'pass')
  } finally {
    stub.close()
  }
})

test('an empty context that is NOT listed is reported as the discovery hole, with its consequence', async () => {
  const stub = stubHarness({ listEmptyContexts: false })
  try {
    const report = await runConformance(stub.target)
    const discovery = rowReportFor(report, 'launch-and-identity')?.results.find((result) => result.id === 'discovery/empty-context-is-listed')
    assert.equal(discovery?.status, 'skipped')
    assert.match(discovery?.detail ?? '', /cannot be discovered/)
  } finally {
    stub.close()
  }
})

test('the model-spend check stays skipped unless it is explicitly allowed', async () => {
  const stub = stubHarness()
  try {
    const report = await runConformance(stub.target)
    const replay = rowReportFor(report, 'quiescence-and-delivery')?.results.find((result) => result.id === 'delivery/load-replays-history')
    assert.equal(replay?.status, 'skipped')
    assert.match(replay?.detail ?? '', /model turn/)
  } finally {
    stub.close()
  }
})

test('rows with no runnable check are visibly unanswered rather than silently absent', async () => {
  const stub = stubHarness()
  try {
    const report = await runConformance(stub.target)
    assert.equal(rowReportFor(report, 'continuity-and-custody')?.results.length, 0)
    assert.equal(rowReportFor(report, 'continuity-and-custody')?.answered, false)
    assert.equal(rowReportFor(report, 'ownership-and-recovery')?.answered, false)
  } finally {
    stub.close()
  }
})

import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import * as acp from '@agentclientprotocol/sdk'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const commandContext = new AsyncLocalStorage()
const timeline = []
let timelinePosition = 0

function mark(label) {
  timelinePosition += 1
  timeline.push({ position: timelinePosition, label })
  return timelinePosition
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value))
}

function rpcIdKey(id) {
  return JSON.stringify(id)
}

function opposite(direction) {
  return direction === 'client_to_agent' ? 'agent_to_client' : 'client_to_agent'
}

function classify(message) {
  if (Array.isArray(message)) return { kind: 'batch', method: null, requestId: null }
  if (typeof message !== 'object' || message === null) {
    return { kind: 'invalid', method: null, requestId: null }
  }
  if ('method' in message && 'id' in message) {
    return { kind: 'request', method: message.method, requestId: message.id }
  }
  if ('method' in message) {
    return { kind: 'notification', method: message.method, requestId: null }
  }
  if ('id' in message) {
    return { kind: 'response', method: null, requestId: message.id }
  }
  return { kind: 'invalid', method: null, requestId: null }
}

class MemoryJournal {
  constructor(validateACPMessage) {
    this.validateACPMessage = validateACPMessage
    this.records = []
    this.requests = new Map()
  }

  async append(direction, frame) {
    const wireBytes = Uint8Array.from(frame)
    const jsonText = decoder.decode(wireBytes).trim()
    const payload = JSON.parse(jsonText)
    const classification = classify(payload)
    const started = mark(`journal:start:${direction}:${classification.kind}`)

    // Simulates an asynchronous durable commit. The wrapped Stream must not
    // forward the message while this promise is pending.
    await new Promise((resolve) => setTimeout(resolve, 1))

    let correlatedMethod = classification.method
    if (classification.kind === 'request') {
      this.requests.set(
        `${direction}:${rpcIdKey(classification.requestId)}`,
        classification.method,
      )
    } else if (classification.kind === 'response') {
      correlatedMethod =
        this.requests.get(`${opposite(direction)}:${rpcIdKey(classification.requestId)}`) ?? null
    }

    const validation = this.validateACPMessage({
      payload,
      direction,
      classification,
      correlatedMethod,
    })

    const record = {
      sequence: this.records.length + 1,
      direction,
      kind: classification.kind,
      method: classification.method,
      correlatedMethod,
      requestId: classification.requestId,
      commandId:
        direction === 'client_to_agent'
          ? (commandContext.getStore()?.commandId ?? null)
          : null,
      jsonText,
      wireSha256: createHash('sha256').update(wireBytes).digest('hex'),
      wireSize: wireBytes.byteLength,
      payload,
      ...validation,
      startedAt: started,
      committedAt: mark(
        `journal:commit:${direction}:${classification.method ?? correlatedMethod ?? classification.kind}`,
      ),
    }
    this.records.push(record)
  }
}

class NdJsonFrameBuffer {
  constructor() {
    this.pending = new Uint8Array()
  }

  push(chunk) {
    const merged = new Uint8Array(this.pending.byteLength + chunk.byteLength)
    merged.set(this.pending)
    merged.set(chunk, this.pending.byteLength)

    const frames = []
    let frameStart = 0
    for (let index = 0; index < merged.byteLength; index += 1) {
      if (merged[index] === 0x0a) {
        frames.push(merged.slice(frameStart, index + 1))
        frameStart = index + 1
      }
    }
    this.pending = merged.slice(frameStart)
    return frames
  }

  flush() {
    if (this.pending.byteLength === 0) return null
    const frame = this.pending
    this.pending = new Uint8Array()
    return frame
  }
}

function journalNdJsonWritable(output, journal, direction) {
  const writer = output.getWriter()
  const frames = new NdJsonFrameBuffer()

  return new WritableStream({
    async write(chunk) {
      for (const frame of frames.push(chunk)) {
        await journal.append(direction, frame)
        await writer.write(frame)
      }
    },
    async close() {
      const finalFrame = frames.flush()
      if (finalFrame) {
        await journal.append(direction, finalFrame)
        await writer.write(finalFrame)
      }
      await writer.close()
    },
    abort(reason) {
      return writer.abort(reason)
    },
  })
}

function journalNdJsonReadable(input, journal, direction) {
  const reader = input.getReader()
  const frames = new NdJsonFrameBuffer()
  const queuedFrames = []
  let inputClosed = false

  return new ReadableStream({
    async pull(controller) {
      while (queuedFrames.length === 0 && !inputClosed) {
        const { value, done } = await reader.read()
        if (done) {
          inputClosed = true
          const finalFrame = frames.flush()
          if (finalFrame) queuedFrames.push(finalFrame)
          break
        }
        if (value) queuedFrames.push(...frames.push(value))
      }

      const frame = queuedFrames.shift()
      if (frame) {
        await journal.append(direction, frame)
        controller.enqueue(frame)
        return
      }
      controller.close()
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

function ndJsonPair(journal) {
  const clientToAgent = new TransformStream()
  const agentToClient = new TransformStream()
  return {
    client: acp.ndJsonStream(
      journalNdJsonWritable(
        clientToAgent.writable,
        journal,
        'client_to_agent',
      ),
      journalNdJsonReadable(
        agentToClient.readable,
        journal,
        'agent_to_client',
      ),
    ),
    agent: acp.ndJsonStream(agentToClient.writable, clientToAgent.readable),
  }
}

function position(label) {
  const entry = timeline.find((candidate) => candidate.label === label)
  assert.ok(entry, `missing timeline entry: ${label}`)
  return entry.position
}

const officialSchema = JSON.parse(
  await readFile(
    new URL('../../../node_modules/@agentclientprotocol/sdk/schema/schema.json', import.meta.url),
    'utf8',
  ),
)
const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
ajv.addFormat('uint16', {
  type: 'number',
  validate: (value) => Number.isInteger(value) && value >= 0 && value <= 65_535,
})
ajv.addFormat('uint32', {
  type: 'number',
  validate: (value) => Number.isInteger(value) && value >= 0 && value <= 4_294_967_295,
})
// JavaScript has no lossless uint64 Number representation. This validator can
// enforce the integer shape only; the raw-frame test below proves why capture
// must happen before JSON.parse.
ajv.addFormat('uint64', {
  type: 'number',
  validate: (value) => Number.isInteger(value) && value >= 0,
})

const validateWireSchema = ajv.compile(officialSchema)
const methodDescriptors = Object.entries(officialSchema.$defs)
  .filter(([, definition]) => definition?.['x-method'])
  .map(([definitionName, definition]) => {
    let kind = null
    if (definitionName.endsWith('Notification')) kind = 'notification'
    else if (definitionName.endsWith('Request')) kind = 'request'
    else if (definitionName.endsWith('Response')) kind = 'response'
    assert.ok(kind, `cannot classify ACP method schema ${definitionName}`)
    return {
      definitionName,
      kind,
      method: definition['x-method'],
      side: definition['x-side'],
    }
  })
const methodValidators = new Map()

function methodValidator(definitionName) {
  let validator = methodValidators.get(definitionName)
  if (!validator) {
    validator = ajv.compile({
      $schema: officialSchema.$schema,
      $defs: officialSchema.$defs,
      $ref: `#/$defs/${definitionName}`,
    })
    methodValidators.set(definitionName, validator)
  }
  return validator
}

function expectedMethodSide(direction, kind) {
  if (kind === 'response') {
    return direction === 'client_to_agent' ? 'client' : 'agent'
  }
  return direction === 'client_to_agent' ? 'agent' : 'client'
}

function validateACPMessage({
  payload,
  direction,
  classification,
  correlatedMethod,
}) {
  const validAgainstWireSchema = validateWireSchema(payload)
  const wireValidationErrors = validAgainstWireSchema
    ? []
    : jsonValue(validateWireSchema.errors ?? [])

  const routedMethod =
    classification.kind === 'response' ? correlatedMethod : classification.method
  const expectedSide = expectedMethodSide(direction, classification.kind)
  const sameMethodAndKind = methodDescriptors.filter(
    (descriptor) =>
      descriptor.kind === classification.kind &&
      descriptor.method === routedMethod,
  )
  const candidates = sameMethodAndKind.filter(
    (descriptor) =>
      descriptor.side === expectedSide ||
      descriptor.side === 'both' ||
      descriptor.side === 'protocol',
  )

  let validAgainstMethodSchema = null
  let methodSchema = null
  let methodValidationErrors = []

  if (
    classification.kind === 'response' &&
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload
  ) {
    // JSON-RPC error responses have no method-specific result body.
    validAgainstMethodSchema = true
  } else if (candidates.length > 0) {
    const body =
      classification.kind === 'response'
        ? payload.result
        : payload.params
    const attempts = candidates.map((descriptor) => {
      const validator = methodValidator(descriptor.definitionName)
      const valid = validator(body)
      return {
        descriptor,
        valid,
        errors: valid ? [] : jsonValue(validator.errors ?? []),
      }
    })
    const accepted = attempts.find((attempt) => attempt.valid)
    validAgainstMethodSchema = Boolean(accepted)
    methodSchema = accepted?.descriptor.definitionName ?? attempts[0].descriptor.definitionName
    methodValidationErrors = accepted
      ? []
      : attempts.flatMap((attempt) => attempt.errors)
  } else if (sameMethodAndKind.length > 0) {
    // A standard method in the wrong direction is not an extension method.
    validAgainstMethodSchema = false
    methodValidationErrors = [
      {
        keyword: 'x-side',
        message: `method ${routedMethod} is invalid in ${direction}`,
      },
    ]
  }

  return {
    validAgainstWireSchema,
    wireValidationErrors,
    validAgainstMethodSchema,
    methodSchema,
    methodValidationErrors,
    canonicalValid:
      validAgainstWireSchema &&
      validAgainstMethodSchema !== false &&
      classification.kind !== 'batch' &&
      classification.kind !== 'invalid',
  }
}

const knownSessionUpdateVariants = officialSchema.$defs.SessionUpdate.oneOf.map(
  (variant) => variant.properties.sessionUpdate.const,
)
assert.deepEqual(knownSessionUpdateVariants, [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
])

const journal = new MemoryJournal(validateACPMessage)
const pair = ndJsonPair(journal)
const typedUpdates = []

const clientApp = acp
  .client({ name: 'agora-wire-journal-spike-client' })
  .onNotification(acp.methods.client.session.update, ({ params }) => {
    typedUpdates.push(params)
    mark(`handler:client:${params.update.sessionUpdate}`)
  })
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    mark(`handler:client:permission:${params.toolCall.toolCallId}`)
    return {
      outcome: {
        outcome: 'selected',
        optionId: 'allow',
      },
    }
  })

const agentApp = acp
  .agent({ name: 'agora-wire-journal-spike-agent' })
  .onRequest(acp.methods.agent.initialize, () => {
    mark('handler:agent:initialize')
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
      },
    }
  })
  .onRequest(acp.methods.agent.session.new, () => {
    mark('handler:agent:session/new')
    return {
      sessionId: 'acp-session-spike',
    }
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    mark('handler:agent:session/prompt')

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-1',
        content: {
          type: 'text',
          text: 'hello from ACP',
          futureContentField: { nested: true },
          _meta: { 'vendor/content': 'preserved' },
        },
        futureUpdateField: ['preserve', 'me'],
        _meta: { 'vendor/update': { exact: true } },
      },
      futureNotificationField: 42,
      _meta: { 'vendor/notification': 'preserved' },
    })

    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Read a file',
        kind: 'read',
        status: 'pending',
      },
      options: [
        {
          optionId: 'allow',
          name: 'Allow',
          kind: 'allow_once',
        },
      ],
    })
    assert.equal(permission.outcome.outcome, 'selected')
    mark('handler:agent:permission-result')

    // This is deliberately invalid against the pinned v1 SessionUpdate union.
    // The raw journal must retain it before the typed SDK rejects it.
    await client.notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'future_update_variant',
        futurePayload: { retained: true },
      },
    })

    await client.notify('vendor/example', {
      opaque: { retained: true },
    })

    return {
      stopReason: 'end_turn',
      _meta: { 'vendor/response': 'preserved' },
    }
  })

const clientConnection = clientApp.connect(pair.client)
const agentConnection = agentApp.connect(pair.agent)

const initializeResponse = await commandContext.run(
  { commandId: 'command-initialize' },
  () =>
    clientConnection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
    }),
)
assert.equal(initializeResponse.protocolVersion, acp.PROTOCOL_VERSION)

const newSessionResponse = await commandContext.run(
  { commandId: 'command-new-session' },
  () =>
    clientConnection.agent.request(acp.methods.agent.session.new, {
      cwd: '/workspace',
      mcpServers: [],
    }),
)
assert.equal(newSessionResponse.sessionId, 'acp-session-spike')

const expectedSdkErrors = []
const originalConsoleError = console.error
console.error = (...args) => {
  if (
    args[0] === 'Error handling notification' &&
    args[2]?.message === 'Invalid params'
  ) {
    expectedSdkErrors.push(args)
    return
  }
  originalConsoleError(...args)
}
let promptResponse
try {
  promptResponse = await commandContext.run(
    { commandId: 'command-prompt' },
    () =>
      clientConnection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: newSessionResponse.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      }),
  )
  // Notification handlers are intentionally detached from the request result.
  // Give the invalid-notification reporting task one turn to settle.
  await new Promise((resolve) => setTimeout(resolve, 10))
} finally {
  console.error = originalConsoleError
}
assert.equal(promptResponse.stopReason, 'end_turn')
assert.equal(
  expectedSdkErrors.length,
  1,
  'the typed SDK must reject exactly the deliberately unknown v1 update',
)

const promptRequest = journal.records.find(
  (record) =>
    record.direction === 'client_to_agent' &&
    record.method === acp.methods.agent.session.prompt,
)
assert.ok(promptRequest)
assert.equal(promptRequest.commandId, 'command-prompt')
assert.ok(
  promptRequest.committedAt < position('handler:agent:session/prompt'),
  'outbound prompt must commit before the Agent handles it',
)

const knownUpdate = journal.records.find(
  (record) =>
    record.direction === 'agent_to_client' &&
    record.method === acp.methods.client.session.update &&
    record.payload.params.update.sessionUpdate === 'agent_message_chunk',
)
assert.ok(knownUpdate)
assert.equal(knownUpdate.validAgainstWireSchema, true)
assert.equal(knownUpdate.validAgainstMethodSchema, true)
assert.equal(knownUpdate.canonicalValid, true)
assert.equal(knownUpdate.payload.params.futureNotificationField, 42)
assert.deepEqual(knownUpdate.payload.params.update.futureUpdateField, ['preserve', 'me'])
assert.deepEqual(knownUpdate.payload.params.update.content.futureContentField, { nested: true })
assert.equal(
  knownUpdate.payload.params.update.content._meta['vendor/content'],
  'preserved',
)
assert.ok(
  knownUpdate.committedAt < position('handler:client:agent_message_chunk'),
  'inbound update must commit before the Client handles it',
)

assert.equal(typedUpdates.length, 1)
assert.equal(typedUpdates[0].futureNotificationField, undefined)
assert.equal(typedUpdates[0].update.futureUpdateField, undefined)
assert.equal(typedUpdates[0].update.content.futureContentField, undefined)
assert.equal(
  typedUpdates[0].update.content._meta['vendor/content'],
  'preserved',
  '_meta is the ACP-supported extension seam',
)

const permissionRequest = journal.records.find(
  (record) =>
    record.direction === 'agent_to_client' &&
    record.method === acp.methods.client.session.requestPermission,
)
assert.ok(permissionRequest)
const permissionResponse = journal.records.find(
  (record) =>
    record.direction === 'client_to_agent' &&
    record.kind === 'response' &&
    record.correlatedMethod === acp.methods.client.session.requestPermission,
)
assert.ok(permissionResponse)
assert.ok(
  permissionResponse.committedAt < position('handler:agent:permission-result'),
  'callback response must commit before the Agent receives it',
)

const promptResult = journal.records.find(
  (record) =>
    record.direction === 'agent_to_client' &&
    record.kind === 'response' &&
    record.correlatedMethod === acp.methods.agent.session.prompt,
)
assert.ok(promptResult)
assert.equal(promptResult.payload.result._meta['vendor/response'], 'preserved')

const futureUpdate = journal.records.find(
  (record) =>
    record.direction === 'agent_to_client' &&
    record.method === acp.methods.client.session.update &&
    record.payload.params.update.sessionUpdate === 'future_update_variant',
)
assert.ok(futureUpdate)
assert.equal(
  futureUpdate.validAgainstWireSchema,
  true,
  'the ACP root schema falls through to ExtNotification for this method collision',
)
assert.equal(futureUpdate.validAgainstMethodSchema, false)
assert.equal(futureUpdate.canonicalValid, false)
assert.equal(futureUpdate.payload.params.update.futurePayload.retained, true)

const extensionNotification = journal.records.find(
  (record) =>
    record.direction === 'agent_to_client' && record.method === 'vendor/example',
)
assert.ok(extensionNotification)
assert.equal(extensionNotification.validAgainstWireSchema, true)
assert.equal(extensionNotification.validAgainstMethodSchema, null)
assert.equal(extensionNotification.canonicalValid, true)
assert.equal(extensionNotification.payload.params.opaque.retained, true)

for (const record of journal.records) {
  assert.deepEqual(
    jsonValue(record.payload),
    record.payload,
    `record ${record.sequence} is not stable through JSON serialization`,
  )
}

clientConnection.close()
agentConnection.close()

// Stable ACP v1 rejects JSON-RPC batches. The observation seam still sees the
// complete frame before the SDK closes the connection.
const batchInput = new TransformStream()
const batchJournal = new MemoryJournal(validateACPMessage)
const batchConnection = acp
  .client({ name: 'agora-wire-journal-batch-spike' })
  .connect(
    acp.ndJsonStream(
      new WritableStream(),
      journalNdJsonReadable(
        batchInput.readable,
        batchJournal,
        'agent_to_client',
      ),
    ),
  )
const batchWriter = batchInput.writable.getWriter()
await batchWriter.write(
  encoder.encode(
    `${JSON.stringify([
      {
        jsonrpc: '2.0',
        method: 'vendor/batched-notification',
        params: { retained: true },
      },
    ])}\n`,
  ),
)
await batchConnection.closed

assert.equal(batchJournal.records.length, 1)
assert.equal(batchJournal.records[0].kind, 'batch')
assert.equal(batchJournal.records[0].validAgainstWireSchema, false)
assert.equal(batchJournal.records[0].canonicalValid, false)
assert.equal(batchJournal.records[0].payload[0].params.retained, true)

// ACP v1 contains uint64 fields, while the TypeScript SDK parses JSON numbers
// into IEEE-754 Number values. Capture at the parsed-object seam is therefore
// not lossless for every value admitted by the official schema.
const unsafeUint64 = '9007199254740993'
const precisionInput = new TransformStream()
const precisionJournal = new MemoryJournal(validateACPMessage)
const precisionStream = acp.ndJsonStream(
  new WritableStream(),
  journalNdJsonReadable(
    precisionInput.readable,
    precisionJournal,
    'agent_to_client',
  ),
)
const precisionReader = precisionStream.readable.getReader()
const precisionWriter = precisionInput.writable.getWriter()
const precisionJson = `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-session-spike","update":{"sessionUpdate":"usage_update","used":${unsafeUint64},"size":1000000}}}\n`
const precisionBytes = encoder.encode(precisionJson)
const parsedPrecisionMessage = precisionReader.read()
const splitAt = Math.floor(precisionBytes.byteLength / 2)
await precisionWriter.write(precisionBytes.slice(0, splitAt))
await precisionWriter.write(precisionBytes.slice(splitAt))
const precisionRead = await parsedPrecisionMessage
assert.equal(precisionRead.done, false)
mark('sdk:parsed:unsafe-uint64')

assert.equal(precisionJournal.records.length, 1)
const precisionRecord = precisionJournal.records[0]
assert.ok(precisionRecord.jsonText.includes(unsafeUint64))
assert.equal(
  precisionRecord.payload.params.update.used,
  9_007_199_254_740_992,
  'JSON.parse rounds the schema-valid uint64 before an object-level journal can observe it',
)
assert.ok(
  precisionRecord.committedAt < position('sdk:parsed:unsafe-uint64'),
  'raw frame must commit before the SDK parses it',
)
assert.equal(precisionRecord.validAgainstMethodSchema, true)
assert.equal(precisionRecord.canonicalValid, true)
await precisionWriter.close()

console.log(
  JSON.stringify(
    {
      sdkVersion: '1.3.0',
      protocolVersion: acp.PROTOCOL_VERSION,
      officialMethodSchemas: methodDescriptors.length,
      knownSessionUpdateVariants,
      journaledMessages: journal.records.length,
      validMessages: journal.records.filter((record) => record.canonicalValid).length,
      rejectedButCapturedMessages: journal.records.filter(
        (record) => !record.canonicalValid,
      ).length,
      rootSchemaAcceptsKnownMethodCollision: true,
      methodDispatchedValidationRequired: true,
      stableV1BatchRejectedAfterCapture: true,
      ordinaryParsedJsonRoundTrip: true,
      objectLevelCaptureLossyForUint64: true,
      rawFrameCaptureRetainsUint64Lexeme: true,
      directRawTextToJsonbRequired: true,
      persistBeforeDispatch: true,
      persistBeforeHandling: true,
      responseMethodCorrelationWithoutPayloadMutation: true,
      outboundCommandCorrelationViaAsyncContext: true,
    },
    null,
    2,
  ),
)

/**
 * Hand-verified TypeScript mirror of contracts/openapi/session-runtime-control.yaml. Every shape
 * here corresponds 1:1 to a schema in that file (`additionalProperties: false` there too) — see
 * test/openapi-parity.test.ts, which loads the real spec and proves it.
 */

export type SessionRuntimeAvailability = 'enabled' | 'unavailable' | 'deprecated'

export interface LaunchableAgent {
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  readonly label: string
  readonly description: string
  readonly availability: SessionRuntimeAvailability
  /** Reviewed persona names this Agent may be launched with (`--agent <name>`). Empty = the product surface offers no persona choice. */
  readonly personas: readonly string[]
}

export interface ListLaunchableAgentsResult {
  readonly registryRevision: string
  readonly items: readonly LaunchableAgent[]
}

/**
 * `executionGrantRef` is a Broker-issued opaque reference — never a bearer token, proxy address,
 * OneCLI control key or provider credential (ADR 0010/0014). `writeOnly`/`x-sensitive` in the spec.
 */
export interface MaterializeSessionRuntimeRequest {
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  /** The reviewed harness persona this Session runs as (`--agent <name>`); absent = none. Frozen at Session creation. */
  readonly persona?: string
  readonly executionGrantRef: string
  readonly restoreFrom?: string | null
  readonly traceparent?: string
}

export type SessionRuntimeState = 'absent' | 'provisioning' | 'ready' | 'capturing' | 'terminating' | 'failed'

export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly code: string
  readonly detail?: string
}

/** Carries no separate runtime identifier: every Session Runtime is addressed only by its Agora Session id (ADR 0005). */
export interface SessionRuntimeStatus {
  readonly sessionId: string
  readonly agentId: string
  readonly runtimeDefinitionVersion: string
  readonly state: SessionRuntimeState
  readonly podUid?: string | null
  readonly failure?: Problem | null
}

export type AcpBridgeTransport = 'websocket' | 'streamable-http'

/** `credential` is `readOnly`/`x-sensitive` in the spec: mint-once, never echoed back, redact from logs. */
export interface ACPBridgeEndpoint {
  readonly transport: AcpBridgeTransport
  readonly url: string
  readonly credential: string
  readonly expiresAt: string
}

export interface CustodySnapshotRef {
  readonly snapshotId: string
  readonly sessionId: string
  readonly generation: number
  readonly captureRequestId: string
  readonly formatId: string
  readonly formatVersion: string
  readonly adapterVersion: string
  readonly syncedThroughSeq: number
  readonly sha256: string
  readonly sizeBytes: number
  readonly createdAt: string
}

/** Fields the spec marks `writeOnly`/`readOnly` + `x-sensitive`; callers must never log these. */
export const SENSITIVE_SESSION_RUNTIME_CONTROL_FIELDS: ReadonlySet<string> = new Set([
  'executionGrantRef',
  'credential',
])

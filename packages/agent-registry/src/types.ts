/** Mirrors contracts/schemas/agent-runtime.schema.json — see test/schema-parity.test.ts. */

export type CustodyConsistency = 'process-quiescence' | 'native-export' | 'snapshot-safe-files'
export type CustodyRestoreCollision = 'fail-if-present' | 'require-empty-root'
export type RolloutState = 'disabled' | 'internal' | 'enabled' | 'deprecated' | 'retired'
export type BridgeTransport = 'websocket' | 'streamable-http'

export interface CustodyFormat {
  readonly formatId: string
  readonly formatVersion: string
}

export interface AgentRuntimeDefinition {
  readonly agentId: string
  readonly version: string
  readonly label: string
  readonly description: string
  readonly imageDigest: string
  readonly acpCommand: readonly string[]
  readonly bridge: { readonly transport: BridgeTransport; readonly listenPort: number }
  readonly stableAcpVersions: readonly number[]
  readonly custody: {
    readonly driverId: string
    readonly readFormats: readonly CustodyFormat[]
    readonly writeFormat: CustodyFormat
    readonly captureRoots: readonly string[]
    readonly credentialExclusions: readonly string[]
    readonly consistency: CustodyConsistency
    readonly restoreCollision: CustodyRestoreCollision
    readonly maxBytes: number
  }
  readonly resources: {
    readonly requests: { readonly cpu: string; readonly memory: string }
    readonly limits: { readonly cpu: string; readonly memory: string; readonly ephemeralStorage: string }
  }
  readonly health: { readonly path: string; readonly initialDelaySeconds: number; readonly timeoutSeconds: number }
  readonly rollout: RolloutState
}

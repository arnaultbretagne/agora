// What the executions package offers to whatever mounts it (the lab, Agora's server): the execution
// mechanics, its Kubernetes client, and its HTTP surfaces.
export {
  ExecutionManager,
  LIMIT_BOUNDS,
  MAX_LINE,
  EXECUTION_LABEL,
  HARNESS_LABEL,
  POOL_LABEL,
  MANAGED_BY,
  MANAGER,
  TERMINAL_CLAIM_REASONS,
  claimName,
  sessionConfig,
  SESSION_CONFIG_ANNOTATION,
  type Limits,
  type ManagerOptions,
  type Handler,
  type Target,
  type ExecutionView,
  type PoolView,
  type CommandResult,
  type CredentialSource,
} from './manager.ts'
export { HttpKube, KubeError, type KubeApi, type Claim, type PodIdentity, type Sandbox } from './kube.ts'
export { createApi, createAnchorReceiver } from './http.ts'
export { privateKeyFrom } from '@agora/harness-bridge/token'

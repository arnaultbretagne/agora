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
  type Limits,
  type ManagerOptions,
  type Handler,
  type Target,
  type ExecutionView,
  type PoolView,
  type CommandResult,
} from './manager.ts'
export { HttpKube, KubeError, type KubeApi, type Claim, type PodIdentity } from './kube.ts'
export { createApi, createAnchorReceiver, type CredentialSource } from './http.ts'
export { privateKeyFrom } from '@agora/harness-bridge/token'

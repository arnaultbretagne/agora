// Agora's side of an execution's credentials (docs/specs/credentials.md): compile its profiles into grants
// and sign them for the gateway; handing the token to the bridge is the executions' job
// (ExecutionManager.attachCredentials). And the accounts' limits, read through the same gateway.
export {
  BASE_PROFILES,
  BASE_PROFILES_ANNOTATION,
  GrantSigner,
  ProfileRefused,
  baseProfiles,
  compileProfile,
  compileProfiles,
  offeredProfiles,
  offers,
  type Grant,
  type GrantSignerOptions,
} from './grants.ts'
export {
  LIMIT_ENDPOINTS,
  SubscriptionLimits,
  getThroughGateway,
  limitsHttp,
  type AccountLimits,
  type GatewayGet,
  type LimitEndpoint,
  type LimitWindow,
  type SubscriptionLimitsOptions,
  type WindowKind,
} from './limits.ts'
export type { Credentials } from '@agora/harness-bridge/outbound'

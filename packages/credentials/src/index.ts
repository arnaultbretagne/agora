// Agora's side of an execution's credentials (docs/specs/credentials.md): compile its profiles into grants
// and sign them for the gateway; handing the token to the bridge is the executions' job
// (ExecutionManager.attachCredentials).
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
export type { Credentials } from '@agora/harness-bridge/outbound'

// Agora's side of an execution's credentials (docs/specs/credentials.md): compile its profiles into grants
// and sign them for the gateway; handing the token to the bridge is the executions' job
// (ExecutionManager.attachCredentials).
export { GrantSigner, ProfileRefused, compileProfile, compileProfiles, type Grant, type GrantSignerOptions } from './grants.ts'
export type { Credentials } from '@agora/harness-bridge/outbound'

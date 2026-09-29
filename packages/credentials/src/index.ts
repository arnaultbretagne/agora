// Agora's side of an execution's credentials (docs/credentials.md): mint a proxy-only Agent Vault
// session, or sign the execution's grants for the gateway; handing either to the bridge is the
// executions' job (ExecutionManager.attachCredentials).
export { AgentVault, AgentVaultRefused, SESSION_TTL_BOUNDS, type AgentVaultOptions } from './agent-vault.ts'
export { GrantSigner, ProfileRefused, compileProfile, compileProfiles, type Grant, type GrantSignerOptions } from './grants.ts'
export type { Credentials } from '@agora/harness-bridge/outbound'

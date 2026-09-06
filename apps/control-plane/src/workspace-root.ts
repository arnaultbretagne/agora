/** The one fixed workspace root every harness Session uses (S8 Step 2/6 — no per-Session cwd yet).
 * Shared by START (verbs/start.ts) and the observation-time session probe (session-probe.ts): both
 * open an ACP connection against the same context, so they must agree on this exactly. */
export const WORKSPACE_ROOT = '/workspace'

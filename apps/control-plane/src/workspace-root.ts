/**
 * The workspace root every ACP call in this process opens against.
 *
 * It is a property of the HARNESS, not of the control plane: the harness definition declares it
 * (contracts/catalogue/harness-definitions.json), the PodSpec launches the adapter with it, and the
 * custody driver derives the transcript's directory slug from it. If this process used a different
 * value, START would create contexts under one root while the driver looked for transcripts under
 * another — which is exactly what the S9 end-to-end run caught: the adapter refused a `cwd` of
 * `/workspace` that does not exist in a Pod whose home is `/home/agent`.
 *
 * So it is configured once at startup from the catalogue, and read everywhere else. A module-level
 * value rather than an option threaded through six call sites, because there is exactly one root per
 * process and the failure mode of getting it wrong is two components silently disagreeing.
 */
export const DEFAULT_WORKSPACE_ROOT = '/workspace'

let configured = DEFAULT_WORKSPACE_ROOT

/** Called once, from the entrypoint, with the reviewed harness definition's own value. */
export function setWorkspaceRoot(root: string): void {
  configured = root
}

export function workspaceRoot(): string {
  return configured
}

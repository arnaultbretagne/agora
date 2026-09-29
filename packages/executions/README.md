# executions

What Agora does for an execution (`docs/specs/executions.md`, "On Agora's side"): request the
sandbox from Agent Sandbox (a `SandboxClaim`), reach its bridge through the Service, relay ACP
while following turns, re-arm the deadline during a turn, receive the anchor the Pod pushes,
resume an execution from an anchor, and hand the bridge its credential. It neither creates nor
deletes any sandbox.

| Folder | Content |
| --- | --- |
| `src/` | The manager, the Kubernetes client, the anchor store, the API. |
| `test/` | The contract, against real bridges and a simulated Kubernetes API. |

Mounted by `apps/lab`, and by Agora's server once it exists.

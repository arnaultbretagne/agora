# executions

The execution mechanics (`docs/specs/executions.md`, "The mechanics"): claims from Agent Sandbox,
connections to their bridges, deadlines, the bridge's routes, and the authentication of the
anchors Pods push. They keep no history and decide nothing about ACP: `Workstreams`
(`@agora/log`) names the executions to run, receives every event through a `Handler`, and asks for
every effect. Nothing here creates or deletes a sandbox.

| Folder | Content |
| --- | --- |
| `src/` | The manager, the Kubernetes client, the HTTP routes and the anchor receiver. |
| `test/` | The mechanics against real bridges; FakeKube, an in-memory Kubernetes API and Agent Sandbox controller, also served over HTTP. |

`npm test -w @agora/executions`. Mounted by `apps/server` with the log.

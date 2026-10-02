# test

| File | Role |
| --- | --- |
| `executions.test.ts` | The mechanics alone, against real bridges running the mock agent. |
| `warming.test.ts` | The pools' Pods warmed with their base profiles, renewed, never after the claim: C8, C9, C11. |
| `fake-kube.ts` | An in-memory Kubernetes API that also plays Agent Sandbox's controller: warm Sandboxes a claim adopts, and at the deadline it deletes the claim and terminates the Pod, which pushes its anchor. |
| `fake-kube-api.ts` | The same, served over HTTP, for an Agora run as its own process. |

`npm test -w @agora/executions`

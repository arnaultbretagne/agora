# test

| File | Role |
| --- | --- |
| `executions.test.ts` | The mechanics alone, against real bridges running the mock agent; and, on a stub of one claim, a Pod read across the margin before its deadline: E40. |
| `warming.test.ts` | The pools' Pods warmed with their base profiles, renewed, never after the claim: C8, C9, C11. |
| `fake-kube.ts` | An in-memory Kubernetes API that also plays Agent Sandbox's controller: warm Sandboxes a claim adopts, and at the deadline it deletes the claim and terminates the Pod, which pushes its anchor. A test may end a Pod before its time — its container killed (`killPod`, `OOMKilled` by default), or the Pod deleted (`deletePod`) —, and refuse the creation of claims (`failCreates`). |
| `fake-kube-api.ts` | The same, served over HTTP, for an Agora run as its own process. |

`npm test -w @agora/executions`

# test

| File | Role |
| --- | --- |
| `executions.test.ts` | The contract, against real bridges running the mock agent. |
| `fake-kube.ts` | An in-memory Kubernetes API that also plays Agent Sandbox's controller: at the deadline, it deletes the claim and terminates the Pod, which pushes its anchor. |

`npm test -w @agora/executions`

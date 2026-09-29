# src

| File | Role |
| --- | --- |
| `manager.ts` | `ExecutionManager`: claims, connection to each bridge, turns, deadline, restore, anchor reception, credential hand-off. |
| `kube.ts` | The Kubernetes API calls, and nothing else (never a deletion). |
| `http.ts` | The API, the SSE stream, the consumer's WebSocket relay and the anchor receiver. |
| `anchors.ts` | The anchor store. |
| `index.ts` | What the package exports. |

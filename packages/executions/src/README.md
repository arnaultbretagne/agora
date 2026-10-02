# src

| File | Role |
| --- | --- |
| `manager.ts` | `ExecutionManager`, the mechanics: claims, a connection to each bridge, deadlines, the bridge's routes, the claim bound to a Pod. Every event goes to its `Handler`. |
| `kube.ts` | The Kubernetes API calls, and nothing else (never a deletion). |
| `http.ts` | The mechanics' API, the SSE stream, the lab's routes and the anchor receiver. |
| `index.ts` | What the package exports. |

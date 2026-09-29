# src

| File | Role |
| --- | --- |
| `main.ts` | The images' entry point: configuration from the environment, anchor push at SIGTERM. |
| `server.ts` | The bridge: adapter, numbered relay, replay, routes, end of the Pod. |
| `outbound.ts` | The outbound proxy: forwards the adapter's `CONNECT`s with the execution's token, refuses everything before. |
| `token.ts` | Agora's Ed25519 token: signing (Agora) and verification (bridge). |
| `anchor.ts` | The anchor: each harness's native directory, reading en bloc, push, restore. |
| `index.ts` | What the package exports. |

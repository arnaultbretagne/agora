# harness-bridge

The image side of the contract (`docs/specs/executions.md`, "The image"): the bridge starts the ACP
adapter, pipes raw ACP lines over one WebSocket and, at SIGTERM, pushes the
harness's native files to Agora. The adapter only goes out through the bridge's outbound proxy,
which opens once Agora attaches a credential (`docs/specs/credentials.md`).

| Folder | Content |
| --- | --- |
| `src/` | The bridge, its entry point, the token, the anchor, the outbound proxy. |
| `test/` | The image contract, against the mock agent; the outbound proxy, against a fake credential proxy. |

Exports: `@agora/harness-bridge` (everything), `@agora/harness-bridge/token`,
`@agora/harness-bridge/anchor`, `@agora/harness-bridge/outbound`.

Agora owns initialization and every record; the bridge numbers and replays nothing. It stops reading while disconnected or
while the socket is full; stdin backpressure pauses the socket. Lines are bounded to 16 MiB.
The instance is carried in the WebSocket upgrade header, never in an ACP message.

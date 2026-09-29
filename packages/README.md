# packages

Shared code, with no deployment identity.

| Folder | Package | Role |
| --- | --- | --- |
| `credentials/` | `@agora/credentials` | An execution's credentials: its profiles compiled into grants, signed by Agora for the gateway. |
| `executions/` | `@agora/executions` | Agora's executions: claims, deadline, ACP relay, anchors, handing a credential to the bridge. |
| `harness-bridge/` | `@agora/harness-bridge` | The bridge in front of the harness in the image, Agora's token, the anchor format, the outbound proxy. |
| `mock-agent/` | `@agora/mock-agent` | The lab's ACP agent without a model. |
| `testkit/` | `@agora/testkit` | Test tools: a local bridge with the mock agent, a WebSocket client. |

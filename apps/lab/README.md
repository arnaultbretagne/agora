# lab

The lab, on `agora-lab.bretagne.dev` behind Pocket-ID. It mounts the `executions` and
`credentials` packages and serves a deliberately bare page to play every case of
`docs/executions.md` and `docs/credentials.md`.

| Folder | Content |
| --- | --- |
| `src/` | The entry point: configuration and mounting of the executions. |
| `public/` | The lab page. |
| `scripts/` | The contract's cases, played against the deployed lab. |

Ports: **8080** for the API and the page, **8081** for the anchor receiver (the only port open
to sandboxes).

| Variable | Default | Role |
| --- | --- | --- |
| `SANDBOX_NAMESPACE` | required | Namespace of the claims and sandboxes. |
| `SIGNING_KEY_FILE` | required | Ed25519 private key that signs the bridge tokens. |
| `ANCHOR_DIR` | `/data/anchors` | Where anchors are stored. |
| `LEASE_SECONDS`, `TURN_CAP_SECONDS`, `RENEW_SECONDS` | 600, 3600, 60 | Lease, maximum turn duration, re-arm cadence. |
| `MAX_ACTIVE` | 4 | Maximum active executions. |
| `LAB` | — | `true` to open the lab's routes. |
| `ANCHOR_AUDIENCE` | `agora-anchors` | Expected audience of the Pods' projected token. |
| `GATEWAY_PROXY` | — | The gateway as sandboxes see it, `host:port`. Without it, no credential can be attached. |
| `GRANTS_KEY_FILE` | required with the gateway | Ed25519 private key that signs an execution's grants. |
| `GRANTS_KEY_ID`, `GRANTS_ISSUER`, `GRANTS_AUDIENCE` | `agora-grants-1`, `agora`, `agora-gateway` | The JWT's `kid` header, `iss` and `aud`, expected by the gateway. |

Image: `docker build -f apps/lab/Dockerfile .` from the root.

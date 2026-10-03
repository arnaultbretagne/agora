# server

Agora's server, on `agora.bretagne.dev` behind Pocket-ID: the execution mechanics and the log
mounted together, with PostgreSQL, serving the client (`apps/web`) at `/`. With `TEST_ROUTES`, it
also opens the test routes and serves at `/test/` a bare page that plays the cases of
`docs/specs/executions.md`, `log.md` and `credentials.md`.

| Folder | Content |
| --- | --- |
| `src/` | The entry point: configuration, mounting, the client's files. |
| `public/` | The test page. |
| `scripts/` | The live cases, played against the deployed server. |

Ports: **8080** for the client, the API and the test page, **8081** for the anchor receiver (the
only port open to sandboxes).

| Variable | Default | Role |
| --- | --- | --- |
| `SANDBOX_NAMESPACE` | required | Namespace of the claims and sandboxes. |
| `SIGNING_KEY_FILE` | required | Ed25519 private key that signs the bridge tokens. |
| `LOG_WRITER_URL`, `LOG_PROJECTOR_URL`, `LOG_ANCHORS_URL` | required | The three runtime logins of the log's database (`packages/log/scripts/README.md`). |
| `LEASE_SECONDS`, `TURN_CAP_SECONDS`, `RENEW_SECONDS` | 600, 3600, 60 | Lease, maximum turn duration, renewal step. |
| `MAX_ACTIVE` | 4 | Maximum active executions. |
| `TEST_ROUTES` | — | `true` to open the test routes and page. |
| `CLIENT_DIR` | `apps/web/dist` | The client's built files. |
| `ANCHOR_AUDIENCE` | `agora-anchors` | Expected audience of the Pods' projected token. |
| `GATEWAY_PROXY` | — | The gateway as sandboxes see it, `host:port`. Without it, no credential can be attached. |
| `GRANTS_KEY_FILE` | required with the gateway | Ed25519 private key that signs an execution's grants. |
| `GRANTS_KEY_ID`, `GRANTS_ISSUER`, `GRANTS_AUDIENCE` | `agora-grants-1`, `agora`, `agora-gateway` | The JWT's `kid` header, `iss` and `aud`, expected by the gateway. |
| `AGORA_FAULT` | — | Tests only: `<point>[:<method>]` kills the process at that fault point (`packages/log/src/workstreams.ts`). |

It exits non-zero when it cannot take the database's ownership, or loses it.

Image: `docker build -f apps/server/Dockerfile .` from the root; it builds the client too.

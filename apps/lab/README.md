# lab

The lab, on `agora-lab.bretagne.dev` behind Pocket-ID. It mounts the `executions`, `credentials` and optional `log` packages and serves a deliberately bare page to play every case of
`docs/specs/executions.md` and `docs/specs/credentials.md`.

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
| `LOG_WRITER_URL`, `LOG_PROJECTOR_URL`, `LOG_ANCHORS_URL` | — | Three restricted PostgreSQL logins; together mount the durable log page and Workstream API. Provision through `packages/log/scripts/migrate.ts`; the application never receives the migration URL. |
| `ANCHOR_DIR` | `/data/anchors` | Where anchors are stored. |
| `LEASE_SECONDS`, `TURN_CAP_SECONDS`, `RENEW_SECONDS` | 600, 3600, 60 | Lease, maximum turn duration, re-arm cadence. |
| `MAX_ACTIVE` | 4 | Maximum active executions. |
| `LAB` | — | `true` to open the lab's routes. |
| `ANCHOR_AUDIENCE` | `agora-anchors` | Expected audience of the Pods' projected token. |
| `GATEWAY_PROXY` | — | The gateway as sandboxes see it, `host:port`. With the log, Claude's base JWT is supplied automatically before opening; without it, no credential can be attached. |
| `GRANTS_KEY_FILE` | required with the gateway | Ed25519 private key that signs an execution's grants. |
| `GRANTS_KEY_ID`, `GRANTS_ISSUER`, `GRANTS_AUDIENCE` | `agora-grants-1`, `agora`, `agora-gateway` | The JWT's `kid` header, `iss` and `aud`, expected by the gateway. |

Image: `docker build -f apps/lab/Dockerfile .` from the root.

With the log mounted, Workstream commands use the journal, database anchors and resumable
thread. Raw execution routes remain a separate diagnostic surface; their manager excludes
claims carrying the execution-id label, so it cannot initialize or drive log-owned bridges.
Log HTTP routes require `LAB=true` and the lab's existing trusted admin boundary.

The log page requires no manual credential attachment. Its assigned Claude executions receive
only the Anthropic base profile; mock executions need no JWT. The diagnostic credential endpoint
uses the same reviewed base-profile selection. Warm-pool grants, provisioned resource access and
between-turn application remain separate contracts. The anchor receiver uses the journal and
claim to accept an ending Pod's files after a restart, without requiring an ACP connection.

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
| `APPROVAL_SECONDS` | 270 | How long an approval of a `spawn_agent` call waits for the person (`docs/specs/delegation.md`, "Approval"). |
| `MAX_ACTIVE` | 4 | Maximum active executions. |
| `TEST_ROUTES` | — | `true` to open the test routes and page. |
| `CLIENT_DIR` | `apps/web/dist` | The client's built files. |
| `ROLES_DIR` | `roles` | The role cards (`docs/specs/roles.md`, "Cards"). A file there that is no card stops the start. |
| `ANCHOR_AUDIENCE` | `agora-anchors` | Expected audience of the Pods' projected token. |
| `GATEWAY_PROXY` | — | The gateway as sandboxes see it, `host:port`. Without it, no credential can be attached. |
| `GRANTS_KEY_FILE` | required with the gateway | Ed25519 private key that signs an execution's grants. |
| `GRANTS_KEY_ID`, `GRANTS_ISSUER`, `GRANTS_AUDIENCE` | `agora-grants-1`, `agora`, `agora-gateway` | The JWT's `kid` header, `iss` and `aud`, expected by the gateway. |
| `AGORA_FAULT` | — | Tests only: `<point>[:<method>]` kills the process at that fault point (`packages/log/src/workstreams.ts`). |

It exits non-zero when it cannot take the database's ownership, or loses it.

Image: `docker build -f apps/server/Dockerfile .` from the root; it builds the client too.

## Preview

With `PREVIEW=true` the same image is a preview (`docs/specs/preview.md`): the server and the client of a
pull request with nothing of production. Its one pool runs the mock agent (`packages/mock-agent`) inside the
server's container, each sandbox a bridge on the loopback; at its first start on an empty database it writes
the conversations of the client's fixtures (`apps/web/test/fixtures`). It calls no Kubernetes API, no gateway,
no bucket, nothing on the Internet.

CI publishes it as `ghcr.io/arnaultbretagne/agora-server:<full commit SHA>` for each commit of a pull request
labelled `preview` whose branch is in this repository (`.github/workflows/preview.yml`). The package is public:
no pull secret.

| Variable | Value |
| --- | --- |
| `PREVIEW` | `true`. |
| `PREVIEW_DATABASE_URL` | Required. `postgresql://<owner>:<password>@<host>:5432/<database>`: an empty PostgreSQL 17 database and the login that owns it, the `uri` of a CloudNativePG `<cluster>-app` Secret. That login needs no other right: no `CREATEROLE`, no superuser. The server applies the log's schema itself, as that owner, at every start. |
| `PORT` | `8080`, as in production: the client, the API and `/healthz`. |
| `MAX_ACTIVE` | `4` by default: sandboxes at once, each a mock agent process in the container. A stopped one counts until its deadline (`LEASE_SECONDS`). |
| `LEASE_SECONDS`, `TURN_CAP_SECONDS`, `RENEW_SECONDS`, `APPROVAL_SECONDS`, `TEST_ROUTES`, `NODE_OPTIONS` | Optional, as in production. |

A preview given any variable that only production sets does not start: it exits 1 with
`PREVIEW excludes <names>`. They are `SANDBOX_NAMESPACE`, `SIGNING_KEY_FILE`, `KUBE_API`, `KUBE_TOKEN_FILE`,
`LOG_WRITER_URL`, `LOG_PROJECTOR_URL`, `LOG_ANCHORS_URL`, `FILES_ENDPOINT`, `FILES_BUCKET`, `FILES_ACCESS_KEY_ID`,
`FILES_SECRET_ACCESS_KEY`, `GATEWAY_PROXY`, `GRANTS_KEY_FILE`, `OFFERED_PROFILES`, `POD_IP`, `GATEWAY_CA_FILE`
and `GITHUB_TEST_API`. Without `PREVIEW_DATABASE_URL`, it exits 1 with `PREVIEW_DATABASE_URL is required`.

What it expects of its environment:

| Need | Detail |
| --- | --- |
| Inbound | Port 8080 only, from the previews' gates. Ports 8081 (its anchor receiver) and 8082 (its MCP server) still listen; only the server itself uses them, over the loopback. |
| Outbound | DNS and its database on 5432; nothing else. No Internet, no API server: no ServiceAccount token is needed (`automountServiceAccountToken: false`). |
| Gates | Both previews' gates: the browser gate's `X-Forwarded-Email` and the gateway gate's `x-agora-gate: gateway` with `Basic client-<id>:none` are taken as they come. The email is the account the client shows; every caller sees and writes the same conversations, those of one shared owner. |
| Public URL | None: no variable carries it (`urlEnv` empty). |
| Files | A writable `/tmp` (an `emptyDir`): each sandbox's home, the mock agent's native files. The root filesystem can be read-only. Files and anchors are kept in the server's memory: a new Pod starts without them, its database kept. |
| User | The image's, `10001`: non-root, every capability dropped, `RuntimeDefault` seccomp. |
| Replicas | One, `Recreate`: the log admits one owner, and a second server would exit on `dispatch_owner_exists`. |
| Health | `GET /healthz` on 8080. |
| Memory | The server and up to `MAX_ACTIVE` mock agents, in one container: a request of 256 Mi and a limit of 1 Gi, as in production. |

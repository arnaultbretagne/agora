# Executions

Contract to implement — Agent Sandbox **v1.0.3**, **Kata** runtime.

**Agora requests a sandbox, talks ACP with it and sets its deadline.
Agent Sandbox allocates the resources and destroys them.**

The contract of an execution: the interface with Agent Sandbox, the image, what Agora does, and
the acceptance cases. How it fits together is explained in `architecture/executions.md`; why, in
the executions ADR.

## Ground rules

- Agora creates no sandbox and never deletes anything: Agent Sandbox allocates and destroys.
- The ACP adapter and the bridge's WebSocket server start in the pool, before any claim. Each
  assignment triggers its replenishment; a used sandbox is never returned to the pool.
- No persistent storage in a sandbox. Whatever the agent wants to keep, it pushes itself: code, a
  note. What Agora keeps is the anchor.

## Agent Sandbox

### The four operations

| Operation | Agora sends to Kubernetes | Agora gets back |
| --- | --- | --- |
| **Obtain** | POST of a `SandboxClaim`: pool via `spec.warmPoolRef.name`, deadline via `spec.lifecycle.shutdownTime`. | The claim's identity. Warm allocation or cold creation. |
| **Observe** | LIST / WATCH of the claims. | `Ready` / `Finished` conditions, `status.sandbox.name` and `status.sandbox.serviceFQDN`. |
| **Renew** | PATCH of `spec.lifecycle.shutdownTime`. | Accepted deadline, absolute, in UTC. |
| **Stop** | Nothing: Agora stops renewing. | Deletion by the infrastructure at the deadline. |

Claims use `spec.lifecycle.shutdownPolicy: DeleteForeground`.
Templates enable `service: true`; the WS port and path are defined with the pool.
After `Ready=True`, the backend reaches the Service and establishes ACP with the required
authorizations. **The claim precedes the WS connection; Ready alone does not prove that ACP is runnable.**

The UI shows startup, then availability or the error. On stop, Agora closes
access and stops renewing; the sandbox disappears at the deadline, without the user waiting.

The claim name comes from the execution: `sbx-` + the first 10 hexadecimal characters
of the SHA-256 of the execution id.

### A 10-minute lease, a 1-hour turn at most

| Parameter | Value |
| --- | --- |
| Lease duration | **10 minutes** |
| Renewal during a turn | **Every minute** |
| Maximum turn duration | **1 hour** |

How the deadline moves is in "The deadline" (On Agora's side). The turn stays open until the
final response to `session/prompt`. Renewal continues during a silent tool or with the browser
closed. The turn start is kept across restarts; neither ACP events nor reconnections push back
the one-hour limit.

At the limit, the infrastructure triggers destruction with the Kubernetes template's
termination delay, with no additional ACP grace period.

**Between two turns:** after an end confirmed before expiry, grant 10 minutes
without renewal. A new prompt restarts the lease if the sandbox is still usable.

### Edge cases

- **Retry:** keep the request's claim name and check its UID before any mutation.
- **Stop or expiry:** no late renewal may cancel them.
- **ACP disconnection:** recovery bounded by the granted deadline, without automatically resending the prompt.
- **Cleanup:** expiry does not prove immediate physical stop.
- **Warm or cold:** `warm` means taken from the pool, even if that Sandbox is still
  starting. `cold` only happens when the pool has nothing left.
- **Kata VM network:** the Cilium DNS proxy's responses do not reach it. No
  FQDN rules for sandboxes: plain DNS, and address ranges.
- **Kata VM clock:** the guest image runs chrony against Ubuntu's NTS servers
  (TCP 4460), which the network policy rejects in a loop. Sync disabled
  (`systemd.mask=chrony.service` in Kata's kernel parameters): time comes from
  kvm-clock, which follows the host.

## The image

### Startup, in the pool

1. Create the fixed workspace `/home/harness/work`, and the native directory the image declares.
2. Start the outbound proxy on loopback, closed until Agora attaches a token: a warm one, if the
   pool declares base profiles (`credentials.md`).
3. Launch the adapter through its *bin* entry, stdio over pipes, `HTTPS_PROXY` pointing at the
   outbound proxy.
4. Listen immediately after spawning the adapter; answer ready on `/healthz` while it runs.

All of this happens before the claim, with no user; the only token is the warm one, for the
pool's base profiles. The bridge sends no ACP.
Agora sends `initialize` on its first connection, with `fs` and `terminal` set to *no*, and keeps
the answer. codex refuses a second `initialize`: Agora never resends it to the same instance.

### The bridge's routes

Port **8080**. Every route except `/healthz` requires Agora's token.

| Route | Role |
| --- | --- |
| `GET /healthz` | 200 while the adapter runs and the Pod is not ending, 503 otherwise. This is the Pod's readiness. |
| `GET /info` | Instance, Pod, workspace, start time, adapter state (alive, exit code, signal), ending, the way out (`outbound`). |
| `GET /acp` | WebSocket: the ACP relay. |
| `PUT /anchor` | Restores an anchor, before `initialize`. |
| `PUT /credentials` | Attaches the credential through which the adapter goes out (`credentials.md`). |

The token is signed by Agora with **Ed25519**, names the target sandbox and expires after
**60 seconds**. The bridge verifies it with Agora's public key and compares the name with
its own Pod's: the sandbox holds no secret. In addition, the NetworkPolicy
only admits ingress from Agora.

### The relay

| Rule | Detail |
| --- | --- |
| A single client | The most recent connection wins; the old one is closed (4000). Every ACP connection numbers its requests from 0: two clients would steal each other's responses. |
| Instance | The WebSocket upgrade response carries `agora-bridge-instance`. No bridge-generated message is sent. |
| Both ways | One WebSocket text message per ACP line, without its newline; stdin receives that line followed by a newline. Contents are never parsed or rewritten. Binary or multiline messages are refused. |
| From the adapter | Read only while a connection is open, and await each send callback and an empty `bufferedAmount` before reading further. There is no ring, numbering or replay; `after` has no meaning here. |
| While Agora is away | Stop reading stdout. The pipe and its bounded stream buffer hold unread bytes; the adapter waits when they fill. The bridge retains only the partial line being assembled and the remainder of one pipe read. |
| To the adapter | Pause the WebSocket while stdin is full; resume on `drain`. A superseded socket can no longer write to stdin. |
| Maximum line | 16 MiB, measured in UTF-8 bytes without the newline. Exceeding it stops the adapter and makes the execution lost. |

If the adapter dies, the current connection closes with 1011 and `/healthz` switches to 503.
The bridge stays alive: `/info` gives the exit code, and the anchor leaves with the Pod.
At SIGTERM the connection closes with 1001, reason "Pod ending", before stopping the adapter.
A crash or network drop can lose lines already sent into the failed connection; unread lines
continue in order on the next connection. No delivery or replay guarantee applies to lines in flight.

### The end of the Pod and the anchor

At the deadline, Agent Sandbox deletes the claim, then its Sandbox and its Pod. The bridge
receives SIGTERM and has the template's termination delay, **30 seconds**, to:

1. close the relay and refuse any new connection;
2. stop the adapter: SIGTERM, then SIGKILL after 5 seconds;
3. read the harness's native files as a whole, stable across two reads 250 ms apart;
4. push them to Agora, three attempts at most;
5. exit.

Agora pulls nothing and does not watch for the Pod's death. With no native file (no
session opened), the bridge pushes an empty anchor.

The anchor keeps what the previous implementation measured: the harness's native files and
nothing else — no `.claude.json`, no authentication file, no global setting
(`harnesses/claude-code/src/driver.ts`, `docs/field-findings.md` §2.2 on `main`).

Each image declares its native directory (`BRIDGE_NATIVE_DIR`), and whether its adapter opens it
when it starts (`BRIDGE_RESTART_ON_ANCHOR`): the bridge has no list of harnesses.

| Harness | Native directory, saved as a whole | Opened at start | Resume |
| --- | --- | --- | --- |
| claude-code | `$HOME/.claude/projects/<workspace slug>/` | No | `session/resume` |
| opencode | `$HOME/.local/share/opencode/agora/`: its SQLite database (`OPENCODE_DB`) | Yes | `session/resume` |
| codex | `$HOME/.codex/sessions/` | — | `session/resume` — to be ported |
| mock (lab) | `$HOME/.mock-agent/sessions/<workspace slug>/` | No | `session/resume` or `session/load` |

The slug is claude-code's: every character outside `[A-Za-z0-9-]` becomes `-`.
That is why the workspace is the same path in every image.

| Action | Rule |
| --- | --- |
| **Push** | `POST` to `AGORA_ANCHOR_URL`. The body lists each file: path relative to the native directory, sha256 checksum, content. 32 MiB at most. |
| **Pod identity** | `Authorization: Bearer` + the ServiceAccount token projected by the kubelet (audience `agora-anchors`, 10 minutes, renewed all the way into the Kata VM), re-read on each push. |
| **Restoring** | `PUT /anchor` with the same body. Each file is written alongside, read back, compared, then renamed. An adapter that reads its files at `session/resume` receives them while it runs. One that opens them at start is stopped first (SIGTERM, then SIGKILL after 5 seconds), the directory replaced as a whole, and the adapter started again; refused (409) once a line has gone to or come from the adapter. |

### What the template provides

| Item | Value |
| --- | --- |
| `runtimeClassName` | `kata` |
| `service` | `true` |
| `restartPolicy` | `Never` |
| `terminationGracePeriodSeconds` | 30 |
| `POD_NAME` | downward API, `metadata.name`: the name expected in Agora's token |
| `BRIDGE_PUBLIC_KEY` | Agora's public key, from the `agora-bridge-key` ConfigMap |
| `AGORA_ANCHOR_URL` | Agora's route for receiving anchors |
| Projected token | `serviceAccountToken` volume, audience `agora-anchors`, mounted on `/var/run/agora/token` |
| Readiness | `GET /healthz` on port 8080 |
| Resources | 50m CPU and 512 MiB reserved, 1 CPU and 1 GiB at most: an idle sandbox uses ~1m, and the node has only 6 cores. |
| `HOME` | `emptyDir` mounted on `/home/harness` |
| User | 10001, read-only root, no capabilities |
| Egress | Through the gateway only, and its TLS trust (`credentials.md`) |

One template and one pool per image, named after its digest. Changing the image means a
new template and a new pool, never an in-place modification.

## On Agora's side

Two parts share the work. The **execution mechanics** (`@agora/executions`) handle the claims, the
bridge connections, the deadlines and the anchors' authentication; they keep no history and decide
nothing about ACP. The **log** (`log.md`) decides: it accepts the commands, writes every line
before acting on it, names the executions to run and asks the mechanics for every effect.

### The mechanics

| Operation | What the mechanics do |
| --- | --- |
| Run | Follow an execution the log names — its claim name and pool — until its claim disappears. |
| Claims | LIST and WATCH the claims labelled `app.kubernetes.io/managed-by=agora`; report each change, and the disappearance, to the log. |
| Create the claim | With the name, pool and deadline the log recorded; a claim already there under that name is taken as is. |
| Renew | PATCH `shutdownTime`, with the claim's UID as precondition. |
| Connect | Once the claim is Ready and not being deleted, to its bridge with a fresh token. The upgrade's `agora-bridge-instance` goes to the log, which accepts the connection or closes it. After a close, reconnect in 2 s — never after 1011 (adapter dead) or 1001 (Pod ending). |
| Receive | Hand each received line to the log, with its connection and receive ordinal, and read nothing more until the log has committed it. |
| Send | A line, on the connection the log names, only when asked; the write's callback settles the request. |
| Hold | No new connection, the open one terminated: an execution lost or failed. |
| Warm | Every 5 seconds, list the pools' Sandboxes; hand each ready one a warm token, and renew it, until a claim binds it (`credentials.md`). |
| Bridge routes | `GET /info`, `PUT /anchor`, `PUT /credentials`, on the log's request. |
| Anchors | Verify a Pod's projected token, and find the claim bound to that Pod. |

### The API

| Route | Role |
| --- | --- |
| `GET /api/pools` | The catalogue: the `SandboxWarmPool`s carrying the `agora.bretagne.dev/harness` label, with their base profiles. |
| `GET /api/executions` | The executions followed: claim, readiness, deadline, Pod, launch type, bridge connection, bytes waiting. |
| `GET /api/events` | SSE stream: the full state at the start, then each changed execution, in full. |
| `GET /api/config` | Whether the lab's routes are open, and the credential profiles on offer. |
| `POST /anchors`, port **8081** | Receive the anchor pushed by a Pod. The only port open to sandboxes. |

The commands — Create, Write, Cancel, Respond to a permission, Stop — and the thread are the log's
(`log.md`, "HTTP"). A Create's settings are bounded: 60 to 600 s for the lease, 30 to 3,600 s for
a turn's duration.

### The deadline

The log decides each move and keeps the turn start; the mechanics apply it.

| Moment | `shutdownTime` |
| --- | --- |
| Creation | now + lease |
| Prompt dispatched | Before its first write, a single PATCH: min(now + lease, turn start + maximum duration). If it fails, the prompt fails (`deadline_refused`) and nothing is sent. |
| Every minute of a turn, while connected to the bridge | min(now + lease, turn start + maximum duration) |
| End of turn confirmed | now + lease, once, then nothing more until the next prompt |
| Stop requested | Nothing more; `session/cancel` if a turn is in progress |
| Adapter lost, instance changed, claim ending | Nothing more |

### An execution's states

Each state is read from the log, and from the claim for its readiness and its end.

| State | Meaning | What proves it |
| --- | --- | --- |
| **starting** | Claim created, not ready yet. | No `execution.connected`; `Ready` false, the claim's reason, the Pod's waiting reason. |
| **connecting** | Claim ready, `initialize` not answered yet. | `execution.connected`, no answer to `initialize`. |
| **restoring** | Anchor placed, resume in progress. | `session/resume` or `session/load` sent, not answered. |
| **ready** | A Session open, no turn. | `session.opened`, no turn in progress. |
| **in turn** | `session/prompt` dispatched, final response not received yet. | Its `acp.dispatching`, no answer. |
| **uncertain** | The end of the turn could not be seen. | An unclean break or a local failure since the dispatch. Only its answer, or the end of the execution, resolves it. |
| **lost** | The adapter died, the bridge instance changed, or the claim conflicts with the record. | `execution.lost`. |
| **stopped** | Sending closed, no more renewal. | The Stop command. |
| **error** | Startup or restore failed. | `execution.failed`: a claim's terminal reason (for example `WarmPoolNotFound`), an unanswered `initialize`, a failed restore. |
| **ending** | The infrastructure is deleting the claim; the anchor is expected. | `deletionTimestamp` on the claim, or its deadline passed. |

The execution ends with `execution.ended` once its claim has disappeared; the entry names the
anchor received, if any.

### Receiving an anchor

Agora has the projected token validated by the Kubernetes API (`TokenReview`, audience
`agora-anchors`) and derives the namespace, the Pod and its UID. It finds that Pod's claim, checks
its labels and its UID against the log, and the Pod's UID against the Pod's; the anchor is then
stored in PostgreSQL by the anchor role, and `anchor.received` appended (`log.md`). A refused token:
401; a Pod of another namespace: 403; a Pod without a claim: 404; a mismatch: 409; an anchor over 32
MiB: 413; nothing is stored. With no push before the claim disappears, the execution ends without an
anchor.

### What Agora writes on the claim

| Field | Content |
| --- | --- |
| `metadata.name` | `sbx-` + the first 10 hexadecimal characters of the SHA-256 of the execution id |
| label `app.kubernetes.io/managed-by` | `agora`: what Agora lists and watches |
| label `agora.bretagne.dev/pool` | the pool |
| label `agora.bretagne.dev/execution-id` | the execution |
| `spec.warmPoolRef.name` | the pool |
| `spec.lifecycle` | `shutdownTime`, and `shutdownPolicy: DeleteForeground` |

Nothing else: no annotation. What Agora must remember about an execution, and how it recovers
after a restart, is the log's (`log.md`, "An execution's memory").

### Restoring

Create with an anchor. Once connected, Agora hands the execution's token, places the anchor
(`PUT /anchor`), sends `initialize`, then `session/resume`, or `session/load` if the agent
advertises only `loadSession`. The anchor goes before the adapter speaks, so an adapter restarted
onto it is the one Agora initializes. A missing anchor, a refused placement or an agent that can
neither resume nor load fails the execution (`anchor_missing`, `restore_failed`); so does an
opening left unanswered.

### Permissions

| Resource (`agora-sandboxes`) | Verbs |
| --- | --- |
| `sandboxclaims` | get, list, watch, create, patch |
| `sandboxwarmpools`, `sandboxtemplates`, `sandboxes`, `pods` | get, list, watch |
| `tokenreviews` (cluster) | create |

A namespace quota bounds the resources; Agora also bounds the number of active executions, since
a pool is not a concurrency limit. A stopped, lost or failed execution counts until its claim has
disappeared.

## The lab

The `apps/lab` deployable mounts the mechanics and the log, with PostgreSQL, and serves a page on
`agora-lab.bretagne.dev`, behind Pocket-ID (admin group). It creates a Workstream per execution,
sends the commands, reads the thread, attaches credentials, and shows deadlines, anchors and
ends. Besides the log's lab routes (`log.md`, "HTTP"), three actions are reserved for the lab:

| Route | Effect |
| --- | --- |
| `POST /api/lab/executions/{name}/drop-bridge` | Agora terminates its connection to the bridge, and reconnects after `pauseSeconds` (0–60) to exercise an absent reader. |
| `POST /api/lab/executions/{name}/probe-auth` | Tries the bridge with no token, with an expired token, with one for another sandbox, with one signed by another key. |
| `POST /api/lab/restart` | `{"mode": "clean"}` stops the process as a SIGTERM would; `{"mode": "kill"}` ends it on the spot, nothing drained or written, with the status a kill leaves. Kubernetes restarts it. |

The **mock** harness is an ACP agent without a model. Depending on the prompt text, it replies
with a numbered echo, sleeps, stays silent, asks for a permission, produces a tool call or a long
text, recalls the session, writes given lines byte for byte, answers twice or invalidly, sends a
request through its way out, or dies. It writes a real native file and reads it back at
`session/resume`.

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| E1 | Create from a warm pool | Ready includes Agora's `initialize`; `warm` launch. |
| E2 | Create beyond the warm pool | Ready includes Agora's `initialize`: `cold`, or `warm` on a pool Sandbox still starting. |
| E3 | Create replayed with the same command id | The first answer: one execution, a single claim. |
| E4 | Pool not in the catalogue, quota reached | Refused, with the reason: `unknown_pool`, `quota`. |
| E12 | Deadline during a turn | Moves forward every minute, never beyond start + maximum duration. |
| E13 | End of turn | Deadline at now + lease, then no more renewal. |
| E14 | Deadline reached between two turns | Destroyed by the infrastructure; the anchor arrives during the grace period. |
| E15 | Turn too long | Destroyed at start + maximum duration; the anchor arrives. |
| E16 | Stop | No more renewal, destruction at the deadline, anchor received. |
| E17 | Stop during a turn | Turn cancelled, then as in E16. |
| E18 | Restore an anchor | New execution, same ACP session, the agent remembers. |
| E19 | Dead adapter | *Lost*, no more renewal; the anchor still leaves with the Pod. |
| E20 | Bridge with no token, expired, for another sandbox, another key | 401 every time. |
| E21 | Anchor push without a valid projected token | 401, nothing is stored. |
| E22 | Real harness (claude-code) | Real `initialize` and `session/new`; anchor pushed and restored. |
| E27 | Agora away while the adapter writes | Unread output arrives complete, in order; the pipe bounds memory and eventually blocks the writer. |
| E29 | Restore onto an adapter that opens its files at start | Declared by its image: the anchor placed before `initialize`, the adapter restarted onto it, the agent remembers. Refused (409) once a line has reached the adapter; without the declaration, the anchor goes unseen. |
| E30 | Real harness (opencode) | Real `initialize` and `session/new` on a warm Pod; a turn on GLM through the gateway, its only way out `api.z.ai`; anchor pushed, then restored by a restart, the agent remembers. |

What happens to the ACP lines themselves — relay, turns, cancellation, permissions, Agora's
restarts — is the log's, with its cases (`log.md`).

**To be specified:** codex's native directory, detached tasks, resuming after the process is lost.
Credentials: `credentials.md`.

Reference: [SandboxClaim v1.0.3](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/extensions/api/v1beta1/sandboxclaim_types.go).

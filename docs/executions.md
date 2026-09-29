# Executions

Contract to implement — Agent Sandbox **v1.0.3**, **Kata** runtime.

**Agora requests a sandbox, talks ACP with it and sets its deadline.
Agent Sandbox allocates the resources and destroys them.**

An **execution** is a harness running in a sandbox obtained from Agent Sandbox. Agora
creates no sandbox: it requests the execution, talks ACP with it, sets its deadline, receives
its anchor and can restore it from an anchor. This document brings together the interface with
Agent Sandbox, the image contract, what Agora does, the decisions made and the validated cases.

## Who does what

- **Agora** builds the complete ACP + WebSocket images and consumes the claims.
- **infra-k8s** configures the templates, pools per versioned image, Kata, network and resources.
- **Agent Sandbox** maintains the warm pool, assigns sandboxes, exposes their state and destroys them.
- **The bridge**, in the image, launches the ACP adapter, relays it without reading it and pushes
  the anchor when the Pod ends.
- **Agora** (package `packages/executions`) creates the claims, relays ACP while tracking
  turns, re-arms the deadline during a turn and stores the anchors. It never deletes anything.

The ACP process and the WS server start in the pool. Each assignment triggers its
replenishment; a used sandbox is never returned to the pool.

No persistent storage in a sandbox. Whatever the agent wants to keep, it pushes
itself: code, a note. What Agora keeps is the anchor.

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

The claim name comes from the request: `sbx-` + the first 10 hexadecimal characters
of the SHA-256 of the request id.

### A 10-minute lease, a 1-hour turn at most

| Chosen parameter | Initial value |
| --- | --- |
| Lease duration | **10 minutes** |
| Renewal during a turn | **Every minute** |
| Maximum turn duration | **1 hour** |

On creation: expiry at `now + 10 min`.
Before the prompt: record the turn start and get its deadline accepted.
During the turn: renew with

```text
shutdownTime = min(now + 10 min, turn start + 1 h)
```

The turn stays open until the final response to `session/prompt`. Renewal
continues during a silent tool or with the browser closed. The turn start is kept
across restarts; neither ACP events nor reconnections push back the one-hour limit.

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

1. Create the fixed workspace `/home/harness/work`.
2. Launch the adapter through its *bin* entry, stdio over pipes.
3. Send `initialize` only once (`fs` and `terminal` set to *no*), keep the response.
4. Answer ready on `/healthz`.

All of this happens before the claim, with no user and no credential. codex refuses a second
`initialize`: Agora never resends it and serves the response kept by the bridge.

### The bridge's routes

Port **8080**. Every route except `/healthz` requires Agora's token.

| Route | Role |
| --- | --- |
| `GET /healthz` | 200 if the adapter is alive and has answered `initialize`, 503 otherwise. This is the Pod's readiness. |
| `GET /info` | Instance, Pod, workspace, `initialize` response, adapter state, last position. |
| `GET /acp` | WebSocket: the ACP relay. |
| `PUT /anchor` | Restores an anchor before the session is resumed. |
| `PUT /credentials` | Attaches the credential through which the adapter goes out (`credentials.md`). |

The token is signed by Agora with **Ed25519**, names the target sandbox and expires after
**60 seconds**. The bridge verifies it with Agora's public key and compares the name with
its own Pod's: the sandbox holds no secret. In addition, the NetworkPolicy
only admits ingress from Agora.

### The relay

| Rule | Detail |
| --- | --- |
| A single client | The most recent connection wins; the old one is closed (4000). Every ACP connection numbers its requests from 0: two clients would steal each other's responses. |
| First message | `hello`: instance, Pod, workspace, `initialize` response, adapter state, replay and `gap`. |
| To the client | Each adapter line becomes `{seq, acp}`: `seq` increases for the instance, `acp` is the raw line. |
| To the adapter | Each text message from the client is a raw ACP line. |
| Without a client | Lines are kept: the last 2,000, 16 MiB at most. |
| Replay | `?after=N` replays what follows position N, with `gap` if some are missing. |

If the adapter dies, the bridge stays alive: `/healthz` switches to 503, `hello` and `/info`
give the exit code, and the anchor will leave with the Pod.

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

The anchor reuses the S9 work: the harness's native files and nothing else, no
`.claude.json`, no authentication file, no global setting
(`harnesses/claude-code/src/driver.ts`, `docs/field-findings.md` §2.2 on `main`).

| Harness | Native directory, saved as a whole | Resume |
| --- | --- | --- |
| claude-code | `$HOME/.claude/projects/<workspace slug>/` | `session/resume` |
| codex | `$HOME/.codex/sessions/` | `session/resume` — to be ported |
| mock (lab) | `$HOME/.mock-agent/sessions/<workspace slug>/` | `session/resume` or `session/load` |

The slug is claude-code's: every character outside `[A-Za-z0-9-]` becomes `-`.
That is why the workspace is the same path in every image.

| Action | Rule |
| --- | --- |
| **Push** | `POST` to `AGORA_ANCHOR_URL`. The body lists each file: path relative to the native directory, sha256 checksum, content. 32 MiB at most. |
| **Pod identity** | `Authorization: Bearer` + the ServiceAccount token projected by the kubelet (audience `agora-anchors`, 10 minutes, renewed all the way into the Kata VM), re-read on each push. |
| **Restoring** | `PUT /anchor` with the same body. Each file is written alongside, read back, compared, then renamed. The adapter reads the file at `session/resume`, not at startup: a pool Pod, already running, can receive it. |

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
| Egress | Through the credential gateway only, and its TLS trust (`credentials.md`) |

One template and one pool per image, named after its digest. Changing the image means a
new template and a new pool, never an in-place modification.

## On Agora's side

### The API

| Route | Role |
| --- | --- |
| `GET /api/pools` | The catalogue: the `SandboxWarmPool`s carrying the `agora.bretagne.dev/harness` label. |
| `GET /api/executions` | Live executions and recent ends. |
| `GET /api/events` | SSE stream: the full state at the start, then each changed execution, in full. |
| `POST /api/executions` | Create: request id, pool, anchor to restore (optional), settings. |
| `POST /api/executions/{name}/stop` | Stop: close sending, cancel the turn, stop renewing. |
| `POST /api/executions/{name}/credentials` | Attach a credential (`credentials.md`). |
| `GET /api/executions/{name}/acp` | WebSocket: the consumer's ACP relay. |
| `GET /api/anchors` | The stored anchors. |
| `GET /api/anchors/{id}/content` | An anchor's content. |
| `POST /anchors`, port **8081** | Receive the anchor pushed by a Pod. The only port open to sandboxes. |

Each command answers *accepted* or *refused, with the reason*. An execution's settings
are bounded: 60 to 600 s for the lease, 30 to 3,600 s for a turn's duration.

### The deadline

| Moment | `shutdownTime` |
| --- | --- |
| Creation | now + lease |
| Prompt admitted | A single PATCH: turn start and now + lease. If it fails, the prompt is refused. |
| Every minute of a turn | min(now + lease, turn start + maximum duration) |
| End of turn confirmed | now + lease, then nothing more until the next prompt |
| Stop requested | Nothing more; `session/cancel` if a turn is in progress |
| Adapter lost, process replaced | Nothing more |

### An execution's states

| State | Meaning | What proves it |
| --- | --- | --- |
| **starting** | Claim created, not ready yet. | `Ready` false; the claim's reason, the Pod's waiting reason. |
| **connecting** | Claim ready, bridge not reached yet. | `Ready` true, no `hello`. |
| **restoring** | Anchor placed, resume in progress. | `PUT /anchor` then `session/resume` in progress. |
| **ready** | Bridge reached, adapter alive, no turn. | `hello`. |
| **in turn** | `session/prompt` sent, final response not received yet. | Turn annotation on the claim. |
| **uncertain** | The end of the turn could not be seen. | `gap` on replay. |
| **lost** | The adapter died or the process was replaced. | `hello`; instance different from the recorded one. |
| **stopped** | Sending closed, no more renewal. | Stop annotation on the claim. |
| **error** | The claim will not succeed. | The claim's reason, for example `WarmPoolNotFound`. |
| **ending** | The infrastructure is deleting the claim; the anchor is expected. | `deletionTimestamp` on the claim. |

The execution leaves the list when its anchor is received or when its claim has disappeared; the
end row keeps the anchor, or the reason it is missing.

### The consumer relay

The consumer is whatever mounts the executions: the lab, or Agora's log.

| Rule | Detail |
| --- | --- |
| Received | The bridge's `{seq, acp}` frames; `{local}`, Agora's own responses (`initialize`, refusals); state `{event}`s. |
| Resume | `?after=N` replays what Agora still has in memory after N, with `gap` if some are missing. |
| `session/prompt` | Refused with a JSON-RPC error if the execution is not ready, if a turn is in progress, or if it is stopped. |
| Session | The response to `session/new`, `session/load` or `session/resume` sets the session an anchor will resume. |
| Permissions | `session/request_permission` goes to the consumer and waits for its answer, even if it has left. |
| Ids | Agora's requests carry `agora-…` ids, never numeric ones. |

### Receiving an anchor

Agora has the projected token validated by the Kubernetes API (`TokenReview`, audience
`agora-anchors`), derives the namespace and the Pod from it, finds that Pod's claim and stores
the anchor with the session recorded on the claim. A refused token: 401; a Pod without a claim:
404; nothing is stored. With no push before the claim disappears, the end is recorded
without an anchor. Storage is a lab volume; Agora's database later.

### What Agora writes on the claim

The claim carries everything needed to resume after an Agora restart.

| Key | Content |
| --- | --- |
| label `app.kubernetes.io/managed-by` | `agora`: what Agora lists and watches |
| label `agora.bretagne.dev/pool` | the requested pool |
| `agora.bretagne.dev/request-id` | the request id |
| `agora.bretagne.dev/limits` | this execution's lease and turn duration |
| `agora.bretagne.dev/restore-anchor`, `…/restored` | the anchor to restore, then the date it was restored |
| `agora.bretagne.dev/instance` | the bridge instance seen on the first connection |
| `agora.bretagne.dev/session-id` | the session an anchor will resume |
| `agora.bretagne.dev/turn` | the turn in progress: start, id of the request, bridge position |
| `agora.bretagne.dev/idle-since` | the end of the last turn |
| `agora.bretagne.dev/stopped` | the requested stop, and its date |

On restart: LIST of the labelled claims, then connection to each bridge with `after`
= the position recorded at the start of the turn in progress. The replay contains the final response: the
turn closes. A gap: *uncertain*. Another instance: *lost*.

### Restoring

Create with an anchor. Once the bridge is reached, Agora places the anchor (`PUT /anchor`)
then sends `session/resume`, or `session/load` if the agent does not advertise
`sessionCapabilities.resume`. A failure leaves the execution in *error*.

### Permissions

| Resource (`agora-sandboxes`) | Verbs |
| --- | --- |
| `sandboxclaims` | get, list, watch, create, patch |
| `sandboxwarmpools`, `sandboxtemplates`, `sandboxes`, `pods` | get, list, watch |
| `tokenreviews` (cluster) | create |

A namespace quota bounds the resources; Agora also bounds the number of
active executions, since a pool is not a concurrency limit. A stopped execution counts
until it is destroyed.

## The lab

The `apps/lab` deployable mounts the `executions` package and serves a page on `agora-lab.bretagne.dev`, behind Pocket-ID (admin
group). It creates sandboxes, relays ACP by hand, shows deadlines, anchors and ends,
and offers three actions reserved for the lab:

| Route | Effect |
| --- | --- |
| `POST /api/lab/executions/{name}/drop-bridge` | Cuts the connection to the bridge; Agora reconnects with replay. |
| `POST /api/lab/executions/{name}/probe-auth` | Tries the bridge with no token, with an expired token, with one for another sandbox, with one signed by another key. |
| `POST /api/lab/restart` | Stops the lab process; Kubernetes restarts it. |

The **mock** harness is an ACP agent without a model. Depending on the prompt text, it replies
with a numbered echo, sleeps, stays silent, asks for a permission, produces a tool call or a long text,
or dies. It writes a real native file and reads it back at `session/resume`.

## Decisions and ruled-out options

Proposed on 27 September 2026.

| Subject | Chosen |
| --- | --- |
| **Execution** | Agent Sandbox: one `SandboxClaim` per request, taken from a warm pool. |
| **Isolation** | Kata: one VM per Pod, RuntimeClass `kata`. |
| **Lifetime** | Agora sets `shutdownTime`, re-arms it during a turn, grants a lease after it. |
| **Destruction** | Only by the infrastructure, at the deadline. |
| **Anchor** | The harness's native files, as a whole, pushed by the Pod when it ends. |
| **Pod identity** | Projected ServiceAccount token, verified by `TokenReview`. |
| **Bridge access** | The Sandbox's Service, Agora's Ed25519 token bound to the Pod name. |
| **Agora's state** | Written on the claim. |

| Ruled out | Why |
| --- | --- |
| Agora deletes claims or Pods | A single actor destroys: the infrastructure. No reaper, no `delete` permission. |
| Home-made Pod controller or reaper | Agent Sandbox already does it. |
| Persistent volume (PVC) in the sandbox | Against the principle, and a PVC on the claim forces a cold start. |
| Renewing between two turns | The lease granted after the turn is enough; after that the infrastructure takes the resource back. |
| Agora pulls the anchor during the grace period | Race between its WATCH and the Pod's death; only the Pod knows when it dies. |
| Saving at every turn | The anchor only matters at the end of the Pod; before that, the live sandbox is the reference. |
| The Pod writes to Agora's database | No database login in an untrusted sandbox. |
| Secret or identity injected through the claim | Forces a cold start and puts a secret in the sandbox. |
| Reaching the Pod by its IP | The Service is the native building block; the Pod no longer needs to be reached during its grace period. |
| Network rules by domain name | The Cilium DNS proxy's responses do not reach a Kata VM. |
| gVisor for these sandboxes | Kata chosen after the 22 September evaluation. |
| Agent Sandbox's upstream router | Agora relays the WebSocket itself. |

Consequences: a stop frees the resource at most one lease later; if Agora is
unreachable during the grace period, the sandbox leaves without an anchor; a turn does not exceed one
hour; restoring from an anchor opens a new session and pays for the whole context again.

## Cases to validate

Run on 27 September on g4, under Kata, by `apps/lab/scripts/live-cases.ts`, and re-run on
29 September: **22 out of 22**. The deadline cases use a 60 s lease,
re-armed three times per lease.

| # | Case | Expected | Measured |
| --- | --- | --- | --- |
| 1 | Create from a warm pool | Ready in under a second, `warm` launch. | Ready in 0.29 s, `warm`. |
| 2 | Create beyond the warm pool | Ready in a few seconds: `cold`, or `warm` on a pool Sandbox still starting. | One `warm` in 0.55 s, then two `cold` in 3.8 and 4.9 s; on the previous run, two `warm` in 2.9 s. |
| 3 | Create twice with the same id | Same execution, a single claim. | Same name, a single claim. |
| 4 | Pool not in the catalogue, quota reached | Refused, with the reason. | 400 "pool not in the catalogue"; 429 "quota reached: 6 active executions out of 6". |
| 5 | Relay: `initialize`, `session/new`, prompt | `initialize` response from the bridge, numbered frames, turn closed. | Local `initialize`, positions 1 → 3, `end_turn`. |
| 6 | Second prompt during a turn | Refused with a JSON-RPC error. | "refused: a turn is already in progress". |
| 7 | Cancel a turn | Ends `cancelled`, execution ready. | `cancelled`, execution ready. |
| 8 | Permission, consumer gone then back | The request is replayed, the answer unblocks the turn. | Request replayed, turn closed. |
| 9 | Consumer disconnected during a turn | The turn continues; resuming returns the missed frames. | 7 frames replayed, no gap. |
| 10 | Bridge connection cut during a turn | Reconnection, replay, turn closed with no gap. | Replay from position 18, turn closed. |
| 11 | Agora restarted during a turn | Turn found through the annotation and closed by the replay. | Turn found *in turn* at restart, closed `end_turn`. |
| 12 | Deadline during a turn | Moves forward every minute, never beyond start + maximum duration. | Deadline pushed back during the turn, under the limit. |
| 13 | End of turn | Deadline at now + lease, then no more renewal. | Deadline set at the end of the turn, unchanged 25 s later. |
| 14 | Deadline reached between two turns | Destroyed by the infrastructure; the anchor arrives during the grace period. | Destroyed by Agent Sandbox; anchor pushed (1 file). |
| 15 | Turn too long | Destroyed at start + maximum duration; the anchor arrives. | Destroyed at start + 30 s; anchor pushed. |
| 16 | Stop | No more renewal, destruction at the deadline, anchor received. | *Stopped*, destroyed at the deadline; anchor with the turn's text. |
| 17 | Stop during a turn | Turn cancelled, then as in 16. | Turn `cancelled`, destroyed at the deadline; anchor pushed. |
| 18 | Restore an anchor | New execution, same session, the agent remembers. | Ready in 0.37 s, session resumed, memory intact. |
| 19 | Dead adapter | *Lost*, no more renewal; the anchor still leaves with the Pod. | *Lost*; anchor pushed despite the dead adapter. |
| 20 | Bridge with no token, expired, for another sandbox, another key | 401 every time. | 401 everywhere; valid token 200 / 101. |
| 21 | Anchor push without a valid projected token | 401, nothing is stored. | 401 without a token, 401 with a fake one. |
| 22 | Real harness (claude-code) | Real `initialize` and `session/new`; anchor pushed and restored. | Without a credential, egress is refused by the bridge: no answer to the prompt in 120 s, turn cancelled; 11,238-byte anchor pushed, restored by `session/resume`. |

**To be specified:** anchor storage in the database, codex's native directory, detached tasks,
resuming after the process is lost. Credentials: `credentials.md`.

References: [SandboxClaim v1.0.3](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/extensions/api/v1beta1/sandboxclaim_types.go);
Kata measurements in `docs/agent-sandbox-evaluation.md` of the `infra-k8s` repository.

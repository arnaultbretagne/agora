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

### A 10-minute lease, a 6-hour ceiling

| Parameter | Value |
| --- | --- |
| Lease duration | **10 minutes** |
| Renewal, while a turn runs or work the agent started still runs | **Every minute** |
| Ceiling | **6 hours** since the last prompt |

The sandbox lives as long as its agent is in a turn, or work it started still runs in the sandbox,
and never beyond the ceiling. How the deadline moves is in "The deadline" (On Agora's side). The
turn stays open until the final response to `session/prompt`. Renewal continues during a silent
tool or with the browser closed, and once the turn is over, while a process the agent started
since its first prompt still runs under its adapter (`GET /info`, "What still runs"). No turn has
a maximum duration of its own. The last prompt's start is in the log, kept across restarts;
neither ACP events nor reconnections push back the ceiling.

At the ceiling, the infrastructure triggers destruction with the Kubernetes template's
termination delay, with no additional ACP grace period.

**Between two turns:** once a turn has ended and nothing the agent started runs any more, grant
10 minutes without renewal. A new prompt restarts the lease if the sandbox is still usable.

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

1. Create the fixed workspace `/home/harness/work`, with the agent's instructions in it
   (`AGENTS.md`, below), and the native directory the image declares.
2. Start the outbound proxy on loopback, closed until Agora attaches a token: a warm one, if the
   pool declares base profiles (`credentials.md`).
3. Launch the adapter through its *bin* entry, stdio over pipes, `HTTPS_PROXY` pointing at the
   outbound proxy.
4. Listen immediately after spawning the adapter; answer ready on `/healthz` while it runs.

All of this happens before the claim, with no user; the only token is the warm one, for the
pool's base profiles. The bridge sends no ACP.
Agora sends `initialize` on its first connection, with `fs` and `terminal` set to *no*,
`subagents` declared (`log.md`, "Native sub-agents") and `elicitation.form` (`log.md`, "Requests"), and keeps the answer. codex refuses a second `initialize`: Agora never resends it to the same instance.

### The bridge's routes

Port **8080**. Every route except `/healthz` requires Agora's token.

| Route | Role |
| --- | --- |
| `GET /healthz` | 200 while the adapter runs and the Pod is not ending, 503 otherwise. This is the Pod's readiness. |
| `GET /info` | Instance, Pod, workspace, start time, adapter state (alive, exit code, signal), ending, the way out (`outbound`), what still runs (`processes`). |
| `GET /acp` | WebSocket: the ACP relay. |
| `PUT /anchor` | Restores an anchor, before `initialize`. |
| `PUT /credentials` | Attaches the credential through which the adapter goes out (`credentials.md`). |

The token is signed by Agora with **Ed25519**, names the target sandbox and expires after
**60 seconds**. The bridge verifies it with Agora's public key and compares the name with
its own Pod's: the sandbox holds no secret. In addition, the NetworkPolicy
only admits ingress from Agora.

### What still runs

`GET /info` lists, in `processes`, the processes the agent's work runs in, oldest first: for each,
its `pid`, its `parent`, its name as the kernel gives it (`command`) and its start (`startedAt`, to
the hundredth of a second). The bridge decides nothing with them; Agora reads them between turns
("The deadline").

| Rule | Detail |
| --- | --- |
| Which | Every process descending from the adapter, read from `/proc`. Not the adapter itself, nor a zombie. |
| Orphans | A process whose parent ended comes to the Pod's first process. The bridge, when it is that process (PID 1, as in the image), also lists what came to it: its own descendants but the adapter. A bridge sharing its process with others, as the preview's, lists only what runs under its adapter. |
| Nowhere to read | Without `/proc`, the list is empty: nothing is known to run. |

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
| codex | `$HOME/.codex/sessions/`: its rollouts; `auth.json` stays outside | No | `session/resume` |
| antigravity | `$HOME/.gemini/antigravity-cli/conversations/`: one SQLite file per conversation; the token file stays outside | No | `session/resume` |
| mock (tests) | `$HOME/.mock-agent/sessions/<workspace slug>/` | No | `session/resume` or `session/load` |

antigravity's, measured on 2026-11-20 on agy 1.5.13 behind a stand-in for Google: a conversation's file
copied alone into the empty `conversations/` of a running agy is listed at once and resumed by
`session/resume`, the model's next request carrying the earlier exchange.

The slug is claude-code's: every character outside `[A-Za-z0-9-]` becomes `-`.
That is why the workspace is the same path in every image.

| Action | Rule |
| --- | --- |
| **Push** | `POST` to `AGORA_ANCHOR_URL`. The body lists each file: path relative to the native directory, sha256 checksum, content. 32 MiB at most. |
| **Pod identity** | `Authorization: Bearer` + the ServiceAccount token projected by the kubelet (audience `agora-anchors`, 10 minutes, renewed all the way into the Kata VM), re-read on each push. |
| **Restoring** | `PUT /anchor` with the same body. Each file is written alongside, read back, compared, then renamed. An adapter that reads its files at `session/resume` receives them while it runs. One that opens them at start is stopped first (SIGTERM, then SIGKILL after 5 seconds), the directory replaced as a whole, and the adapter started again; refused (409) once a line has gone to or come from the adapter. |

### What the agent is told

| Element | Rule |
| --- | --- |
| `AGENTS.md` | Written into the workspace by the bridge as it starts, before the adapter: the text of `packages/harness-bridge/src/agent-instructions.md`, the same for every harness. claude-code, opencode and codex load it as project instructions, with no setting. agy 1.5.13 was not seen to (`credentials.md`, "Antigravity"). |
| What it says | The workspace starts empty; the conversation outlives the Pod, files do not, so work is pushed before a task is called done and cloned again into an empty workspace. Everything goes out through the gateway; what its 403 and 404 mean. Where the agent's access is written and how each profile reads. Its tools: Node and git, git's identity. |
| `~/.agora/access.json` | The claims of the token the agent goes out with (`credentials.md`). |

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
| Resources | 50m CPU and 512 MiB reserved, 1 CPU and 4 GiB at most: an idle sandbox uses ~1m, and the node has only 6 cores. Kata sizes the VM at the memory limit, so the limit is all the RAM the agent has: at 1 GiB, three sub-agents and 25 processes started at once ran it out. |
| `HOME` | `emptyDir` mounted on `/home/harness` |
| User | 10001, read-only root, no capabilities |
| Egress | Through the gateway only, and its TLS trust (`credentials.md`) |
| git identity | `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME` `agora-contributor[bot]`, `GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_EMAIL` its noreply address: a commit shows the GitHub App that pushes it, never the operator (`credentials.md`, "GitHub identities"). The same for every execution. |

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
| `GET /api/pools` | The catalogue: the `SandboxWarmPool`s carrying the `agora.bretagne.dev/harness` label, with their base profiles and their Session settings: the annotation `agora.bretagne.dev/session-config`, `id=value` pairs separated by commas, in order (a malformed pair is left out). Each Session of the pool starts with them (`log.md`, "Sessions"). A pool annotated `agora.bretagne.dev/purpose: testing` is listed with `testing`: kept for the tests, it is not offered by the screen. |
| `GET /api/executions` | The executions followed of the caller's Workstreams (`log.md`, "HTTP"): claim, readiness, deadline, Pod, launch type, bridge connection, bytes waiting. |
| `GET /api/events` | SSE stream: the full state at the start, then each changed execution, in full; the caller's alone, as the list. |
| `GET /api/config` | Whether the test routes are open, and the credential profiles on offer. |
| `POST /anchors`, port **8081** | Receive the anchor pushed by a Pod. The only port open to sandboxes. |
| `POST /mcp`, port **8082** | Agora's MCP server (`mcp.md`), open to the gateway alone, each message proving its caller by the grant the gateway forwards. |

The commands — Create, Write, Cancel, Respond to a permission, Stop — and the thread are the log's
(`log.md`, "HTTP"). A Create's settings are bounded: 60 to 600 s for the lease, 30 to 21,600 s for
the ceiling (`leaseSeconds`, `ceilingSeconds`); the server's `LEASE_SECONDS` and `CEILING_SECONDS`
otherwise, 600 and 21,600. Any other key is ignored, `turnCapSeconds` included: no turn has a
maximum duration of its own.

### The deadline

The log decides each move and keeps each turn's start; the mechanics apply it. The **ceiling** is
the last prompt's start — the start of the execution's last turn — plus its ceiling, 6 hours by
default. Every move is bounded by it.

| Moment | `shutdownTime` |
| --- | --- |
| Creation | now + lease |
| Prompt dispatched | Before its first write, a single PATCH: min(now + lease, its start + ceiling); that prompt is now the last. If it fails, the prompt fails (`deadline_refused`) and nothing is sent. |
| Every minute of a turn, while connected to the bridge | min(now + lease, ceiling) |
| End of turn confirmed | min(now + lease, ceiling), once |
| Every minute once the turn is over, while connected to the bridge and work the agent started still runs | min(now + lease, ceiling) |
| The first minute that work is no longer seen running | min(now + lease, ceiling), once, then nothing more until the next prompt |
| Stop requested | Nothing more; `session/cancel` if a turn is in progress |
| Adapter exited, or a prompt answered with an internal error (JSON-RPC `-32603`) | now, once, then nothing more: the execution is lost, and its Pod ends and pushes its anchor without waiting out the lease |
| Instance changed, claim ending | Nothing more |

**Work still running.** Once a turn is over, each time a renewal would be due — at most once a
minute —, Agora asks the bridge what runs (`GET /info`, "What still runs"). Work runs while it
lists a process started at or after the start of the execution's first turn: what the harness
started before — its own processes, the servers it opens with its Session — is not the agent's
work. A bridge that does not answer renews nothing. Which execution had work running is kept in
memory: after a restart of Agora, the work it sees running renews as before, and work that ended
meanwhile ends with the lease already granted.

The ceiling counts the time but the time approvals waited (`delegation.md`, "Approval"): each wait
since the last prompt, from the approval's Ask to its answer, refusal or expiry, pushes it back by
as much.

The execution's token always outlives the deadline it is given: before each move, Agora hands a new
one if needed (`credentials.md`, "Between turns").

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
| **lost** | The adapter died, the agent answered a prompt with an internal error, the bridge instance changed, or the claim conflicts with the record. | `execution.lost`. |
| **stopped** | Sending closed, no more renewal. | The Stop command. |
| **error** | Startup or restore failed. | `execution.failed`: a claim's terminal reason (for example `WarmPoolNotFound`), an unanswered `initialize`, a failed restore. |
| **ending** | The infrastructure is deleting the claim; the anchor is expected. | `deletionTimestamp` on the claim, or its deadline passed. |

The execution ends with `execution.ended` once its claim has disappeared; the entry names the
anchor received, if any.

### Receiving an anchor

Agora has the projected token validated by the Kubernetes API (`TokenReview`, audience
`agora-anchors`) and derives the namespace, the Pod and its UID. It finds that Pod's claim, checks
its labels and its UID against the log, and the Pod's UID against the Pod's; the anchor's bytes are
then stored in R2 and its record by the anchor role (`files.md`), and `anchor.received` appended
(`log.md`). A refused token: 401; a Pod of another namespace: 403; a Pod without a claim: 404; a
mismatch: 409; an anchor over 32 MiB: 413; R2 failing: 503; nothing is stored. With no push before
the claim disappears, the execution ends without an anchor.

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

Create with an anchor, named or found by the log (`log.md`, "Continuing"). Once connected, Agora hands the execution's token, places the anchor
(`PUT /anchor`), sends `initialize`, then `session/resume`, or `session/load` if the agent
advertises only `loadSession`. The anchor goes before the adapter speaks, so an adapter restarted
onto it is the one Agora initializes. A missing anchor, a refused placement, an anchor R2 does not
give back or an agent that can neither resume nor load fails the execution (`anchor_missing`,
`restore_failed`); so does an opening left unanswered.

### Permissions

| Resource (`agora-sandboxes`) | Verbs |
| --- | --- |
| `sandboxclaims` | get, list, watch, create, patch |
| `sandboxwarmpools`, `sandboxtemplates`, `sandboxes`, `pods` | get, list, watch |
| `tokenreviews` (cluster) | create |

A namespace quota bounds the resources; Agora also bounds the number of active executions, since
a pool is not a concurrency limit. A stopped, lost or failed execution counts until its claim has
disappeared.

## The server

The `apps/server` deployable mounts the mechanics and the log, with PostgreSQL, and serves the
client (`assistant-ui.md`) on `agora.bretagne.dev`, behind Pocket-ID (admin group). With its test
routes open (`TEST_ROUTES` `true`), it also serves the test page at `/test/`: a Workstream per
execution, the commands, the thread, credentials, deadlines, anchors and ends. Besides the log's
test routes (`log.md`, "HTTP"), three actions are reserved for tests. The two that name an execution,
by its claim's name or its id, act only on an execution of the caller's Workstreams; another owner's
is answered as one Agora does not know (`log.md`, "HTTP").

| Route | Effect |
| --- | --- |
| `POST /api/test/executions/{name}/drop-bridge` | Agora terminates its connection to the bridge, and reconnects after `pauseSeconds` (0–60) to exercise an absent reader. |
| `POST /api/test/executions/{name}/probe-auth` | Tries the bridge with no token, with an expired token, with one for another sandbox, with one signed by another key. |
| `POST /api/test/restart` | `{"mode": "clean"}` stops the process as a SIGTERM would; `{"mode": "kill"}` ends it on the spot, nothing drained or written, with the status a kill leaves. Kubernetes restarts it. |

The **mock** harness is an ACP agent without a model. Depending on the prompt text, it replies
with a numbered echo, sleeps, stays silent, asks for a permission, produces a tool call or a long
text, recalls the session, writes given lines byte for byte, answers twice or invalidly, sends a
request through its way out, leaves a command running once its turn is over (`/background N NAME`,
writing NAME in the workspace after N seconds), reads a file of its workspace (`/read NAME`), or dies. It writes a real native file and reads it back at
`session/resume`.

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| E1 | Create from a warm pool | Ready includes Agora's `initialize`; `warm` launch. |
| E2 | Create beyond the warm pool | Ready includes Agora's `initialize`: `cold`, or `warm` on a pool Sandbox still starting. |
| E3 | Create replayed with the same command id | The first answer: one execution, a single claim. |
| E4 | Pool not in the catalogue, quota reached | Refused, with the reason: `unknown_pool`, `quota`. |
| E12 | Deadline during a turn | Moves forward every minute, never beyond the last prompt + the ceiling. |
| E13 | End of turn, nothing left running | Deadline at now + lease, then no more renewal. |
| E14 | Deadline reached between two turns, nothing left running | Destroyed by the infrastructure one lease after the turn; the anchor arrives during the grace period. |
| E16 | Stop | No more renewal, destruction at the deadline, anchor received. |
| E17 | Stop during a turn | Turn cancelled, then as in E16. |
| E18 | Restore an anchor | New execution, same ACP session, the agent remembers. |
| E19 | Dead adapter | *Lost*; the deadline moved to now, then no more renewal; the execution ends at once, the anchor leaving with the Pod. |
| E20 | Bridge with no token, expired, for another sandbox, another key | 401 every time. |
| E21 | Anchor push without a valid projected token | 401, nothing is stored. |
| E22 | Real harness (claude-code) | Real `initialize` and `session/new`; anchor pushed and restored. |
| E27 | Agora away while the adapter writes | Unread output arrives complete, in order; the pipe bounds memory and eventually blocks the writer. |
| E29 | Restore onto an adapter that opens its files at start | Declared by its image: the anchor placed before `initialize`, the adapter restarted onto it, the agent remembers. Refused (409) once a line has reached the adapter; without the declaration, the anchor goes unseen. |
| E30 | Real harness (opencode) | Real `initialize` and `session/new` on a warm Pod; a turn on GLM through the gateway, its only way out `api.z.ai`; anchor pushed, then restored by a restart, the agent remembers. |
| E31 | Real harness (codex) | Real `initialize` and `session/new` on a warm Pod; a turn on the ChatGPT subscription through the gateway, its only way out `chatgpt.com`; anchor pushed, then restored, the agent remembers. |
| E32 | A Pod starting | `AGENTS.md` in the workspace, byte for byte the bridge's text, there when the adapter starts. |
| E33 | claude-code, opencode and codex, each in a new Session, asked where their access is written | Each answers `~/.agora/access.json` without a tool call: the workspace's `AGENTS.md` was loaded. |
| E34 | Real harness (antigravity) | Real `initialize` and `session/new` on a warm Pod; a turn on the cluster's Google login through the gateway, its only ways out `daily-cloudcode-pa.googleapis.com` and `www.googleapis.com`; anchor pushed, then restored, the agent remembers. |
| E35 | antigravity in a new Session, asked where its access is written | It answers `~/.agora/access.json` without a tool call: the workspace's `AGENTS.md` was loaded. |
| E36 | A turn of 120 s (`/sleep 120`), the Create naming `turnCapSeconds` 30 | The turn ends with its answer, `Slept 120 s.`; its deadline moved on past 30 s and past the lease; the execution `ready`, neither `ending` nor `lost`. |
| E37 | A command the agent leaves running after its turn (`/background`), longer than the lease; a prompt once it has ended | The deadline moves every minute while it runs, the claim still there past the lease the end of the turn granted; once it has ended, now + lease, once, then no more renewal; the prompt reaches the same Pod and reads the command's output file. |
| E38 | Work still running at the ceiling since the last prompt | The deadline reaches the ceiling and never goes beyond; the infrastructure destroys the sandbox there; the execution ends, its anchor received. |
| E39 | `GET /info` with only the adapter running, while a command it started runs, once that command has ended | No process; then the command's shell and its `sleep`, each with its parent and a start after the prompt, never the adapter; then none. |

What happens to the ACP lines themselves — relay, turns, cancellation, permissions, Agora's
restarts — is the log's, with its cases (`log.md`).

The cases the log took over keep their IDs, for the runs that showed them before
(`reliability/executions.md`): their Expected no longer holds, and the log's cases say what does.

| ID | Case | Expected |
| --- | --- | --- |
| E5 | Relay: `initialize`, `session/new`, prompt | `initialize` answered by Agora, positions numbered by Agora, turn closed. |
| E6 | Second prompt during a turn | Refused with a JSON-RPC error. |
| E7 | Cancel a turn | Ends `cancelled`, execution ready. |
| E8 | Permission, consumer gone then back | The request is replayed, the answer unblocks the turn. |
| E9 | Consumer disconnected during a turn | The turn continues; resuming returns the missed frames. |
| E10 | Bridge connection cut during a turn | Reconnection without replay; *uncertain* until the final answer; unread lines complete and ordered. |
| E11 | Agora restarted during a turn | Turn found through its annotation, *uncertain*, then closed by lines arriving after reconnection; initialization is never resent. |
| E28 | Restarted Agora initializes an existing adapter | Retained answer reused; the mock, which rejects a second `initialize`, stays ready. Consumer receives `reset`. |

The case the ceiling replaced keeps its ID, for the runs that showed it before
(`reliability/executions.md`): its Expected no longer holds, and E36 and E38 say what does.

| ID | Case | Expected |
| --- | --- | --- |
| E15 | Turn too long | Destroyed at start + maximum duration, an hour at most; the anchor arrives. |

**To be specified:** detached tasks, resuming after the process is lost.
Credentials: `credentials.md`.

Reference: [SandboxClaim v1.0.3](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.3/extensions/api/v1beta1/sandboxclaim_types.go).

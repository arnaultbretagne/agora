# Runbook

What an operator does, and what each action actually costs. Every procedure here says what it
touches and what it cannot undo.

## Deploy

```sh
kubectl apply -k deploy/overlays/dev
```

The overlay pins images by digest. A tag is a name that can come to mean something else; "which code
is running" has to be answerable from the manifest alone.

Before applying, the four secrets in [deploy/README.md](../../deploy/README.md) must exist. They are
never in this repository, not even as placeholders — a placeholder is something someone eventually
mistakes for a value.

**Check the deployment is actually serving, not merely running:**

```sh
kubectl -n agora-system get pods
curl -fsS http://control-plane.agora-system.svc.cluster.local:8080/v1/readyz
```

`readyz` is not a liveness check. It reaches runtime-control on every call and reports the failure
if it cannot: an API that answers while it cannot reach its owners takes requests it can only refuse.

## Prove the deployment end to end

```sh
CONTROL_PLANE_URL=http://control-plane…:8080 OWNER=<a principal> node scripts/s13-live-end-to-end.mjs
```

Nine steps, each reported on its own line: the catalogue, a Workstream, a complete Intent,
convergence, a Session with a bound ACP context, **an answer from the model**, a Save with its
Anchor on power off, a restore on power on, and the same native context id across the two Sessions.
It spends real model calls and creates a real Pod, deliberately, and leaves the Workstream off.

A failing step names itself, which is the point: "a prompt is answered BY THE MODEL" failing while
the other eight pass is a credential problem and nothing else — the whole engine works and the
gateway refused the call. Read OneCLI's own log before believing its answer to the caller
("When a harness cannot reach a provider", below).

Both harnesses are proven this way, `HARNESS=claude-code` and `HARNESS=codex` (with `MODEL` and
`CAPABILITY` to match). The companion script goes one step further and proves they share a
Workstream without sharing a context:

```sh
CONTROL_PLANE_URL=http://control-plane…:8080 OWNER=<a principal> node scripts/s13-live-a-b-a.mjs
```

A plants a codeword and is powered off; B comes up on its own fresh context and must NOT know it;
A comes back on ITS anchor, resumes the same native context id, and still does. Four real model
calls across two real Pods. It is the same story `scripts/s10-a-b-a.mjs` tells against stubs, with
nothing stubbed.

## Publish a catalogue revision

Editing `contracts/catalogue/*` and re-applying the overlay produces a new ConfigMap name (the
generator is content-suffixed), so every workload restarts onto the same revision at once. Then tell
the deployment which revision is now selected:

```sh
curl -fsS -XPOST http://control-plane…:8080/v1/admin/revisions \
  -H 'x-agora-service-actor: <the configured operator>' \
  -H 'content-type: application/json' \
  -d '{"revisionId":"<the new catalogue signature>"}'
```

From the moment that commits, a worker still resolving the previous revision refuses to author or
admit anything rather than acting on a superseded catalogue (`SESSION-A11`). The response is `202`:
enumeration and re-enqueue are bounded and resumable, and the sweep owes the rest. Check what is
still owed with a `GET` on the same path.

**A re-pinned image digest is an ordinary publication.** It wakes every affected Workstream, the rule
tables see a Pod whose admitted digest no longer matches the catalogue, and `CONSTRUCT-002` replaces
it — after a bounded Save, because that is what TURN_OFF does. Nothing special has to be done to make
that happen, and nothing can be done to make it skip the Save.

## Rotate the bridge signing secret

The bridge token is HMAC over the incarnation with `BRIDGE_AUTH_SECRET`, minted at gate release and
verified by the Pod. Rotating it invalidates every LIVE Pod's token:

1. update the `agora-bridge-auth` secret;
2. restart runtime-control (it mints) — harness Pods verify against the mounted secret, so they must
   be replaced too;
3. the running Workstreams' Pods are now unreachable by the control plane. They are not corrupt:
   `observation.session` goes `unusable`, `SESSION-005` selects cleanup, and the next tick rebuilds
   with a Save already taken if one could be.

Rotate deliberately, not casually: the cost is one context replacement per live Workstream.

## Back up and restore OneCLI

Three assets, all three required. Any one missing and the restore looks fine until the first
credential injection or the first TLS handshake through the relay.

| Asset | Where | What its loss breaks |
|---|---|---|
| PostgreSQL database | CNPG cluster `onecli-pg` in `agora-onecli`, continuously archived to R2 (`s3://bretagne-pg-backups/onecli`) | every Agent, grant and stored secret |
| `/app/data` | the `onecli-data` PVC | the gateway CA — every already-running Pod's `NODE_EXTRA_CA_CERTS` stops validating |
| `secret-encryption-key` (inside `/app/data`, mirrored to the `agora-onecli` secret) | infra-k8s `apps/agora-onecli/onecli-data-dr.secrets.yaml`, SOPS/age | the restored database cannot be decrypted; the rows are there and unreadable |

**Back up:** the database backs itself up (CNPG scheduled backup + WAL archiving to R2 — check
`kubectl -n agora-onecli get backups`). The other two are captured by hand into infra-k8s's SOPS file
and must be re-captured after ANY change to `/app/data`:

```sh
kubectl -n agora-onecli exec deploy/onecli -- cat /app/data/secret-encryption-key   # into the SOPS file, never into a shell history
kubectl -n agora-onecli exec deploy/onecli -- cat /app/data/ca.crt                  # same file; also mirrored to the agora-runs CA ConfigMap
```

**Restore, in this order:** the key first (nothing else is readable without it), then the database,
then `/app/data`, then restart OneCLI. Then prove it rather than assume it:

- a capability that requires an injected credential still resolves (ask the Broker to compile one);
- the CA in `/app/data` matches the `agora-onecli-ca` ConfigMap the harness Pods mount — if it does
  not, every running Pod's egress is failing TLS validation and only new Pods will work.

**A database restore alone is not a restore.** The g4 cutover moved the database and gave OneCLI a
fresh `/app/data`; it generated a NEW encryption key and every stored credential became undecryptable
while looking perfectly present. The gateway reported that as `access_restricted … attach the
account`, which is the wrong diagnosis; the cure was putting the original key back
(field findings §2.2).

## Recover a deleted OneCLI secret

Performed for real on 2026-09-07, after a `DELETE /v1/secrets/{id}` took the long-lived Claude Max
token with it. That token exists nowhere else (field findings §2.2), so this procedure is the only
thing between a bad delete and re-authenticating a subscription by hand.

1. **Find a backup older than the deletion** and a target time a few minutes before it:
   `kubectl -n agora-onecli get backups` (each names its `beginWal`/`stoppedAt`).
2. **Restore into a throwaway pod, never over the live cluster.** Copy
   `infra-k8s/apps/agora-onecli/restore-test.yaml` — it already has the barman env, the R2 endpoint
   and the `tmp` emptyDir the read-only root filesystem needs — and set
   `recovery_target_time` to that target. Start the restored instance on port 5433 over a unix
   socket in `/tmp`; it is a promoted timeline of its own and touches nothing.
3. **Copy the row out of the pod, not through the live database.** The Cilium policy on `onecli-pg`
   admits only OneCLI itself, the CNPG operator and the cluster's own instances, so the recovery pod
   CANNOT reach the live database — a `psql "$LIVE_URI"` there hangs until it times out. Do not widen
   the policy for a one-off. Have the job `\copy` the row to a file and hold, then:

   ```sh
   kubectl -n agora-onecli exec <recovery-pod> -- cat /tmp/anthropic.tsv > row.tsv    # ciphertext, never printed
   { cat head.sql; cat row.tsv; printf '\\.\n'; cat tail.sql; } |
     kubectl -n agora-onecli exec -i onecli-pg-1 -c postgres -- psql -d onecli -f -
   ```

   where `head.sql` opens a transaction and `create temporary table incoming (like secrets including
   defaults) on commit drop; \copy incoming (<the 15 columns>) from stdin`, and `tail.sql` does the
   `insert … select … on conflict (id) do nothing; commit;`. **`including defaults` matters**: the
   live schema has since gained a NOT NULL `value_source` that the backup's row does not carry, and
   only the default fills it.
4. **Leave exactly one secret per provider type.** The Broker resolves credentials `uniqueBy` type
   and drops an ambiguous type entirely, so a duplicate is not harmless: re-point
   `policy_rule_targets.secret_id` (and `agent_secrets`, `budgets` if used) to the restored id, then
   delete the duplicate.
5. `kubectl -n agora-onecli rollout restart deploy/onecli`, then prove it with the live check —
   `HARNESS=claude-code node scripts/s13-live-end-to-end.mjs` must reach step 6 with a real answer.
   Nothing short of a model answer proves a credential.

## A Workstream that restores itself over and over

```sh
kubectl -n agora-system logs deploy/control-plane-worker | grep -c 'executed RESTORE'
```

Thousands of them in an hour, always the same Workstreams, always preceded by `session probe for …
failed`, is one Workstream burning the worker's every tick — and since the worker is single, every
OTHER Workstream stalls behind it. That is how it was found: a live A → B → A run timed out waiting
for a harness that was never the problem.

`SESSION-002` selecting RESTORE is correct behaviour for an unusable Session; the question is why the
Session reads unusable when the Pod is healthy. Ask the Pod directly, from the worker:

```sh
kubectl -n agora-runs get pod <pod> -o jsonpath='{.status.podIP}'
kubectl -n agora-system exec deploy/control-plane-worker -- node -e "…"   # TCP connect to :8765
```

An open port with a refused upgrade is a token problem, not a network one. Historically it was an
expired bridge token that nothing renewed (field findings §2.2b); renewal is automatic now, and the
worker says so — `bridge token renewed for session …`. If a renewal is refused instead, the line
names the HTTP status runtime-control answered with, and the cause is there: no Pod by that name, or
a Pod that is no longer `Running`.

## Drain a node

The worker, runtime-control and the Broker are `maxUnavailable: 0`. A drain will BLOCK on them, and
that is deliberate: each holds something a drain must not interrupt half-way — a claimed work row
mid-verb, a shutdown inside its preservation budget, a relay carrying a turn.

To proceed, decide explicitly:

```sh
kubectl drain <node> --ignore-daemonsets            # blocks on the PDBs; read what it names
kubectl -n agora-system rollout restart deploy/control-plane-worker   # move it yourself, when nothing is mid-verb
```

Harness Pods in `agora-runs` are `restartPolicy: Never` and are not rescheduled. Draining a node
carrying one ends that incarnation; the Workstream rebuilds, restoring from its Anchor if it has one.

## Resume a Workstream whose retry budget is exhausted

`blocking_cause = action_exhausted:<VERB>` means five attempts failed and the engine stopped
repeating an unchanged action (`ENGINE-011`). The bounded recheck keeps the row visible; it does not
retry, deliberately. Only **a new Intent or a materially changed source/revision** resets it, which
is the specification's rule and not an implementation shortcut.

So after fixing an external cause — a NetworkPolicy, a credential, a stale CA — author the Intent
again (the same values, a new `Idempotency-Key`). Nothing else will make the Workstream try:

```sh
curl -fsS -XPUT http://control-plane…:8080/v1/workstreams/<id>/intent \
  -H "x-forwarded-email: <owner>" -H 'idempotency-key: resume-<date>' \
  -H 'content-type: application/json' -d '<the same complete Intent>'
```

## When a harness cannot reach a provider: read the GATEWAY's log, not its answer

OneCLI's gateway answers the caller with `access_restricted` — *"credentials exist in OneCLI but
this agent does not have access. Ask the user to attach the account to this agent"* — for a
situation that has nothing to do with grants. Its own log says what actually happened:

```sh
kubectl -n agora-onecli logs deploy/onecli | grep -iE "decrypt|skipping secret|credential not found"
```

```
WARN onecli_gateway::connect: app connection decrypt failed (wrong key or format mismatch)
WARN onecli_gateway::connect: skipping secret: decryption failed  host_pattern=api.anthropic.com
```

That is a **wrong `secret-encryption-key`**, not a missing grant. It happened here: the g4 cutover
restored OneCLI's database from its CNPG backup and gave it a fresh `/app/data`, so OneCLI generated
a new key and every stored credential became ciphertext nobody could read. Checking grants proves
nothing — `GET /v1/agents/{id}/grants` and `/v1/policy/effective-app-permissions` both said *allow*,
for every agent including OneCLI's own default, while the gateway refused all of them.

The key lives on OneCLI's volume, and infra-k8s keeps an encrypted capture of it
(`apps/agora-onecli/onecli-data-dr.secrets.yaml`). **A database restore alone is not a restore**:
restore that volume too, before starting OneCLI, or it will generate a fresh key and orphan
everything.

Three states, three different lines, worth telling apart:

| Gateway says | Log says | Means |
|---|---|---|
| `access_restricted` | `decryption failed` | wrong encryption key — restore `/app/data` |
| `access_restricted` | nothing | genuinely no grant for that agent |
| `credential_not_found` | nothing | usually the REQUEST, not the credential: an OAuth-mode secret is injected by REPLACING an `Authorization: Bearer` header, so a probe sent without one has nothing to replace. Retry it with the harness's own placeholder (`Bearer onecli-managed`) before suspecting the credential |
| upstream 401 with `injections_applied=N` | `token refresh failed` | injection works; the provider token is expired — sign in again |

A fifth state never reaches the gateway at all: **two secrets of the same provider type**. The Broker
takes credentials `uniqueBy` type and drops a type that is ambiguous, so the capability simply stops
resolving and the Workstream blocks before any request is made. Registering a "fresh" token beside
the existing one is therefore not a harmless experiment — check
`select id, name, type from secrets` first, and keep exactly one per type
(field findings §2.2).

## Check the harness Pods' trust anchor after ANY OneCLI change

Every harness Pod mounts `agora-onecli-ca` as its only trust anchor for the relay's TLS
interception. OneCLI generates that CA into `/app/data`, so a new volume — a restore, a migration, a
recreated PVC — silently produces a new one, and the ConfigMap keeps the old.

The symptom names nothing useful: every provider call fails inside the agent with *"API Error:
Unable to connect to API: Self-signed certificate detected. Check your proxy or corporate SSL
certificates"*. It has now happened three times.

```sh
kubectl -n agora-onecli exec deploy/onecli -- cat /app/data/gateway/ca.pem | openssl x509 -noout -dates
kubectl -n agora-runs get cm agora-onecli-ca -o jsonpath='{.data.ca\.pem}' | openssl x509 -noout -dates
```

The two `notBefore` dates must match. They are the check after every OneCLI change, and the first
thing to look at when a harness cannot reach a provider.

## Handle an unresolved retirement obligation

An obligation stays open when a Pod was force-deleted and its node cannot be proved to have stopped
running it (`OFF-005`). Nothing infers that discharge — successor work stays blocked until a human
says the node is fenced:

```sh
curl -fsS http://runtime-control…:8090/v1/workstreams/<id>          # see what is outstanding
kubectl cordon <node> && kubectl drain <node> --force               # actually fence it
curl -fsS -XPOST http://runtime-control…:8090/v1/pods/<pod>/fence   # then declare it
```

The `fence` call is the one discharge path the system never takes on its own. Making it easy to call
would defeat it; the operator asserts the node is drained and cordoned, and owns that assertion.

## Retention

Retention runs as its own PostgreSQL role (`agora_retention`) that can delete recovery material and
cannot create or anchor any — a component that could both publish an Anchor and delete the Save under
it can quietly lose a recovery point.

The grace periods are in `contracts/catalogue/retention-settings.json`. Every one is a floor on how
long something is kept, never a promise that it is deleted the moment it expires.

**Deleting a Workstream** extinguishes execution first and removes recovery material second. It is
refused while a Pod exists, while an obligation is unresolved, or while a Session still holds
attribution — the refusal names which. Deletion waits for extinction; it does not cause it.

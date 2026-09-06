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
| PostgreSQL database | `agora-onecli/DATABASE_URL` | every Agent, grant and stored secret |
| `/app/data` | the `onecli-data` PVC | the gateway CA — every already-running Pod's `NODE_EXTRA_CA_CERTS` stops validating |
| `SECRET_ENCRYPTION_KEY` | `agora-onecli` secret | the restored database cannot be decrypted; the rows are there and unreadable |

**Back up:**

```sh
kubectl -n agora-system exec deploy/onecli-postgres -- pg_dump -Fc onecli > onecli-$(date +%F).dump
kubectl -n agora-system exec deploy/onecli -- tar czf - /app/data > onecli-data-$(date +%F).tgz
kubectl -n agora-system get secret agora-onecli -o jsonpath='{.data.SECRET_ENCRYPTION_KEY}' | base64 -d > onecli-key   # store it where the other two are not
```

**Restore, in this order:** the key first (nothing else is readable without it), then the database,
then `/app/data`, then restart OneCLI. Then prove it rather than assume it:

- a capability that requires an injected credential still resolves (ask the Broker to compile one);
- the CA in `/app/data` matches the `agora-onecli-ca` ConfigMap the harness Pods mount — if it does
  not, every running Pod's egress is failing TLS validation and only new Pods will work.

**This drill has not been performed against the live cluster from this repository.** It is written
from the measured asset list (field findings §3.2), and performing it is a deployment action for an
operator, not something to run unattended.

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

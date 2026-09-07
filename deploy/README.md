# deploy/

Kustomize manifests for the control plane, runtime-control, the Broker and OneCLI.

```sh
kubectl apply -k deploy/overlays/dev
```

**What lives where.** `base/` is complete and environment-agnostic: workloads, services, resource
limits and PodDisruptionBudgets, plus the catalogue mounted as a ConfigMap. `overlays/dev/` pins
image digests and pulls in `contracts/k8s/` — the namespace, RBAC and NetworkPolicies that are
reviewed contracts rather than deployment details.

**Secrets are never in this repository**, not even as placeholders. These are referenced by name and
created out of band — plus `ghcr-pull`, a `kubernetes.io/dockerconfigjson` registry credential that
must exist in BOTH `agora-system` and `agora-runs`, because the images are private packages:

| Secret | Keys | Held by |
|---|---|---|
| `agora-database` | `CONTROL_PLANE_URL`, `ENGINE_URL`, `CUSTODY_PAYLOAD_URL` | one connection string per PostgreSQL role (contracts/db/schema.sql) |
| `agora-bridge-auth` | `BRIDGE_AUTH_SECRET` | runtime-control (mints) and every harness Pod (verifies) |
| `agora-onecli` | `CONTROL_KEY`, `SECRET_ENCRYPTION_KEY`, `DATABASE_URL` | the Broker holds the control key; OneCLI holds the rest |
| `agora-broker` | `BROKER_ENCRYPTION_KEY` | the Broker's private store, where Agent bearers are encrypted at rest (ADR 0009) |
| `agora-operator` | `PUBLICATION_SERVICE_ACTOR` | whoever may publish a catalogue revision |

**OneCLI may already exist.** `base/onecli.yaml` deploys one for an environment that has none. An
environment that already runs OneCLI — with its agents, grants, gateway CA and encryption key
already in place — should drop that resource in its overlay and point `ONECLI_URL` /
`ONECLI_GATEWAY_URL` at the existing service instead; `overlays/live/` does exactly that. A second,
empty OneCLI holds no provider credential, so nothing launched against it can reach a model.

**A catalogue change is a rollout.** The ConfigMap is content-suffixed, so editing
`contracts/catalogue/*` produces a new name and every workload restarts onto the same revision at
once. That is what makes "publish a revision" and "all workers agree on it" the same event
(`SESSION-A11`) rather than two things that usually happen close together.

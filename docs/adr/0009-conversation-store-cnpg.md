# ADR 0009 — Durable conversation store on CNPG Postgres (the two-tier state model)

## Status

Accepted — 2026-07-04 (options weighed with the operator; CNPG chosen, RAM cost accepted eyes-open).
Settles the storage question ADR 0005 deliberately left open (*"Where it lives — the website pod's
DB / volume — settled while building"*). ADR 0005's ownership model and ADR 0007's transcript
posture are both unchanged.

## Context

The hub's neutral history is the **sole source of truth** (ADR 0005) — and today its only copy is a
directory of JSON files on the `agora-data` PVC: `local-path` storage on a single node, **no backup
of any kind**. A dead disk = every conversation ever, gone. ADR 0005's *"the history must not depend
on a runtime PVC"* was about **whose** disk the record lives on; it never addressed the durability
of its own.

The framing that sizes the problem: the platform's conversation state is **two-tier** —

| tier | what | where | on loss |
|---|---|---|---|
| 1. neutral history | convs + turns, hub format | `agora-data` PVC | **the product record is gone — unacceptable** |
| 2. native transcripts | claude's JSONL | `agent-claude` PVC | reopen degrades to re-seed (ADR 0007) — slower/flatter, zero broken |

Tier 2 is *deliberately* disposable: ADR 0007 engineered resume so transcripts may vanish without
consequence (*"lose the PVC and you lose speed, never correctness"*), and ADR 0005 forbids depending
on their format. **They stay on the PVC, unmanaged — sinking them anywhere would be gold-plating a
format we are contractually not allowed to rely on.** Only tier 1 needs real durability, and it is
small (32 KB for the whole store today), relational (conversations, ordered turns), with tiny,
frequent writes.

The infra side already standardised what durable-relational means on this cluster (infra-k8s ADR
0012): **CloudNativePG + Barman to R2** — one operator, single-source S3 creds (ResourceSet
`copyFrom`), continuous WAL archiving (PITR, RPO ≈ minutes), daily base backup, a daily **restore
drill** proving the chain end-to-end, and CNPG alert rules. pocket-id runs the full pattern in
production.

Options weighed:

- **A. Keep files, sync to S3** (rclone/restic CronJob → R2). Consistency is actually fine (writes
  are per-conv atomic tmp+rename), but RPO = the cron interval, and it is a **second, bespoke backup
  pipeline**: its own alerting, its own restore drill, built and maintained from scratch, for one app.
- **B. CNPG Postgres.** Rides the entire existing chain for ~40 lines of YAML; costs one more PG
  instance (~150 Mi resident) and an async store refactor.
- **C. SQLite + Litestream.** Smallest footprint and continuous replication, but a divergent
  tool/pattern with its own restore semantics — against the one-pattern-per-problem discipline the
  cluster just spent a month converging on.

## Decision

**The hub's conversation store moves to a dedicated CNPG Postgres cluster (`agora-pg`, 1 instance,
namespace `agent`), WAL-archived to R2 like every other stateful app. Native transcripts stay on the
runtime PVC, explicitly unmanaged (tier 2).**

Concretely:

1. **Schema = the honest relational shape**: `conversations` (one row per conv: metadata + a
   `natives` jsonb column — ADR 0007's handle map lands in the schema from day one) and `messages`
   (append-only, `PRIMARY KEY (conv_id, seq)`). A turn is an INSERT, not a rewrite of the whole
   conversation document.
2. **Timestamps stay ISO-8601 text** — byte-faithful to the existing wire format, lexicographically
   sortable, and the store is the only reader/writer (no DB-side time arithmetic wanted).
3. The store keeps its **in-RAM map**: reads stay synchronous and the hub's hot path is untouched.
   Mutations become `async` — **write-through, serialised, awaited**: a turn is acknowledged only
   once committed.
4. **No file fallback in prod.** `NODE_ENV=production` without a `DATABASE_URL` is a boot failure —
   fail fast, never silently run memory-only. Dev and unit tests use the same store class without
   persistence (in-memory); the `.poc` rig loses cross-restart persistence unless pointed at a PG.
5. **Dedicated cluster, modest budget, no `bretagne-critical`**: agora is not on the cluster's own
   critical path (unlike the IdP), and the box is 16 GB with a fresh memory incident — 128 Mi
   request / 384 Mi limit, `retentionPolicy: 3d` like pocket-id.
6. The restore-drill alert (`CNPGRestoreDrillFailed`) generalises its job regex from
   `pocket-id-pg-restore-test.*` to any `*-pg-restore-test` job — the next stateful app gets the
   alert for free.

## Rationale

- **The durability chain is the expensive part, and it already exists.** Operator, creds
  distribution, WAL→R2, retention, restore drill, alerting: all deployed, all *tested daily*.
  Option A rebuilds most of that bespoke; option B inherits it. An untested backup is not a backup —
  agora's backups are drill-tested from day one.
- **RPO in minutes, not hours.** WAL archiving bounds loss to roughly the archive timeout (5 min
  CNPG default) vs a sync cron's interval. Losing the last few minutes of a chat on a disk death is
  acceptable; losing a day of it isn't.
- **The relational shape is what the data is.** Convs + append-only turns: per-turn INSERTs end the
  rewrite-the-whole-JSON write amplification, boot stops being "parse every file ever" as history
  grows, and cross-conversation search (future UI) becomes a query instead of a scan.
- **One more PG instance is the price of pattern-uniformity** — accepted deliberately, with the
  modest resource envelope and no critical priority as the counterweight.

## Consequences

- `website/lib/store.js`: in-memory base class + PG-backed subclass (async mutations, serialised
  write queue, schema bootstrap at open); every store call site in `hub.js`/`server.js` gains
  `await`. A failed commit **throws to its caller** — user-visible on the send path, loudly logged
  on the reply path: DB-down is degraded-and-visible, never silent divergence.
- `infra-k8s/apps/agent/`: CNPG `Cluster` + `ScheduledBackup` + restore-drill CronJob (clones of the
  pocket-id trio), netpol additions (website→pg :5432; pg↔operator/apiserver/DNS/R2), a ResourceSet
  entry for the creds copy, and `DATABASE_URL` injected from the CNPG-generated `agora-pg-app`
  secret. **Zero new secrets to author or SOPS.**
- One-shot migration of the existing JSON files; the `agora-data` PVC stays mounted as a belt during
  a validation window, then is retired (a gated cleanup).
- The `agent-claude` PVC (transcripts) is consciously **not** backed up — that is ADR 0007's
  contract, restated here as the two-tier model.
- Privacy posture: conversation content now leaves the box (R2, TLS in transit, encrypted at rest) —
  same posture as the IdP database, which already does this.

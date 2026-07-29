# Database contract

Apply migrations in lexical order with a dedicated migrator identity:

1. `001-initial.sql`
2. `002-access.sql`

Application code allocates UUIDs and timestamps. Sequence allocation for Workstream and Session
events is performed transactionally by the store implementation while locking the owning rows.

Tests MUST run against real PostgreSQL and additionally prove:

- Workstream creation includes an owner membership and initial Session in one transaction, and
  repository transactions cannot remove the last owner;
- one current Session per Workstream;
- unique, write-once Agent/ACP Session binding and capability-policy binding;
- immutable Session launch/equipment facts through application-role column grants;
- Session/Workstream composite ownership;
- append-only journal privileges and atomic journal-outbox insertion;
- immutable snapshot generations;
- one-way snapshot invalidation and non-decreasing Workstream/Session/Anchor heads;
- capture request idempotency per Session;
- Anchor ownership, snapshot equality, non-regression and `watermark <= Workstream head` in the
  repository transaction;
- denied `custody.payload` reads for control-plane roles;
- per-Workstream projection checkpoints, durable feed positions and full rebuild.

The DDL creates NOLOGIN privilege roles only. Deployment bootstraps a migration LOGIN/ownership path
and grants `agora_migrator`; it creates no application credential in SQL.

There is no `SessionRuntime` table or `runtime_id`. Durable Session phase is stored on
`product.sessions`; live materialization state is read from the Session Runtime controller.

OneCLI owns a separate operational PostgreSQL database. Its credentials, Agents, policy and request
audit MUST NOT be added to these product/projection/custody migrations.

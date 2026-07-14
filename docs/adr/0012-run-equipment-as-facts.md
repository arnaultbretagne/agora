# 0012 — Run equipment as facts: capability profile + target

- **Status**: Proposed (2026-07-14)
- **Deciders**: Arnault (review + direction), Claude (design)
- **Extends**: ADR 0010 (runs as facts) — equipment is two more frozen run-facts. Pairs with
  agent-runtime ADR 0011 (the broker) and ADR 0012 (the profile catalogue). Amends ADR 0002 (channels)
  via the listener split (see 0002's amendment). Master plan: `/srv/agent-broker-execution-plan.md`
  §2.3 and P4.

## Context

The broker (agent-runtime ADR 0011) equips a loge, per run, with exactly one capability profile — plus a
target for repo profiles. "What a run is equipped with" is run configuration, and ADR 0010 already
settled how run config is modelled: intent is not fact, **the config travels with the message**, it
**freezes on the run**, and a *different* config is a *new run* — never a mutation. Equipment must obey
that model rather than become a mutable conversation setting or a scope the browser can compose. Two
security constraints ride on top: a compromised loge must not be able to raise its own equipment, and the
selection UI must never hand the loge a lease or a free capability list.

## Decision

### 1. Two new run-facts

```sql
ALTER TABLE runs
  ADD COLUMN equipment_profile text NOT NULL DEFAULT 'chat-v1',
  ADD COLUMN target text;
```

Frozen at spawn exactly like `kind/model/effort/agent`. Additive migration: historical runs take
`chat-v1`, `target = NULL`. `runs-as-facts` still records no *placement* (ADR 0011 substrate stays
manager policy) — equipment is *capability*, which the run legitimately journals.

### 2. Config travels with the message

`equipment_profile` + `target` ride in the message config (`POST /conversations {text, config}`,
`POST …/messages {text, config}`), like `kind/model`. Same config as the live run → plain push into it;
different config → a new run. The browser sends a **profile id** (+ target), never capabilities, GitHub
permissions, provider URLs or a lease.

### 3. Immutability and new-run-on-change

Changing profile or target creates a **new run**; a live run is never re-equipped. Both values join
`sameConfig`. The conversation history shows the profile + target each turn actually used.

### 4. Constraints (application, and SQL where possible)

- `equipment_profile` ∈ the known catalogue;
- a target is required for repo profiles, forbidden otherwise;
- agora validates target **syntax**; the manager re-validates **authority** (agent-runtime ADR 0012);
- a `credentialLease` / scope list arriving in a request is stripped or refused.

### 5. Shared catalogue, single authority

agora consumes a build-time **projection** of the agent-runtime catalogue — `{ label, description,
needsTarget, visible }` only, never the capability lists. The security authority stays in agent-runtime;
the manager is the final authority and refuses any profile its version does not know.

### 6. UI (P4.3)

An **Equipment** selector: `Chat` visible and default; `Vault` visible after P5; `Repo — read` after
P6; write profiles hidden until the infra gate opens. Target via an allow-listed autocomplete, not a
free URL. A badge shows the run's profile + target; changing it warns "a new run will be created". The
**channel listener (8601) cannot call the API that sets equipment** — only the human API on 8600 (behind
oauth2-proxy) can, which is why the listener split (ADR 0002 amendment) is a prerequisite, not an
optimisation.

## Consequences

- The migration is additive; historical runs read back as `chat-v1`/no-target; no data rewrite.
- Equipment is a fact like `model`: audit, history and any future multi-harness view derive from it, no
  duplication.
- The browser cannot self-equip a loge, and a loge cannot re-equip itself — profile/target authority is
  server-side end to end.
- Rollback (plan P4): hide the selector and force new runs to `chat-v1`; keep the additive columns.

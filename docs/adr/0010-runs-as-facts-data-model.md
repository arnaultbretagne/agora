# 0010 — Runs as facts: the per-run data model

- **Status**: Accepted (2026-07-04)
- **Deciders**: Arnault (review + direction), Claude (design)
- **Supersedes**: the ADR 0009 schema (conversations + messages only); amends ADR 0007's
  `natives` representation and ADR 0008's patch semantics.

## Context

The first per-message model stamping (2026-07-04, `8e54552`) bolted `resolved_model` onto both
`conversations` and `messages`. Review verdict: wrong grain. The duplication was the symptom; the
missing entity was the cause. Everything the system establishes — one model per process life
(kill-on-patch), per-message audit truth, the resume anchor, multi-harness segments — revolves
around one thing the schema didn't have: **the run**, a spawned runtime with a frozen execution
config. It even had an id already (`<convId>-rN`, the supervisor session id).

Two further insights from the same review:

1. **Intent must not masquerade as fact.** `conversations.{kind,model,effort,agent}` looked like
   truth but was only "config for the next spawn". Worse: an intent stored server-side is dead
   weight — changing a selector has zero effect until a message is sent, and the message that IS
   sent defines the run. So the client owns the intent; **the config travels with the message**.
2. **A conversation is born with its first message.** An empty conversation has no title (derived
   from the first user turn), no kind, no runs — it is nothing. The draft is client state.

## Decision

Four tables, one role each:

```
conversations — identity + state        runs — facts, immutable*              messages — content
  id, title, title_source, pinned         id '<convId>-rN' PK                   (conv_id, seq) PK
  created_at, updated_at, seq             conv_id FK CASCADE                    id, role, text, ts, reply_to
  error_reason, error_ts                  kind, model, effort?, agent?          run_id FK NULL → runs
  live_run_id, live_token                 resolved_model? (backfilled once)       assistant → its producer
  (the runtime lease, no FK —             native_title? (follows the topic)       user / pre-v3 → NULL
   ephemeral state, code-managed)         native_session_id, resume bool
                                          spawned_at
                                          (* resolved_model: one write when
anchors — resume state (the "refs")          the supervisor reads it)
  (conv_id, kind) PK
  run_id FK → runs, synced_seq
```

- **`runs` is the journal** (git: the log). A run freezes `{kind, model, effort, agent}` at spawn;
  `resolved_model` is filled once when readable. Messages point at their producing run — model,
  harness, agent per message are all *derived*, never duplicated, and retroactively correct the
  moment the run learns its `resolved_model` (no per-message backfill, no race).
- **`anchors` is the mutable pointer** (git: the refs). One per (conv, kind): "resume this run's
  native session; it knows hub history up to `synced_seq`". Advanced on every reply, deleted by
  the fallback. Formerly the `natives` jsonb — now relational because it points at rows.
- **`conversations` carries no execution config.** `POST /conversations {text, config}` creates
  conv + first message atomically (no empty conversations); `POST …/messages {text, config}`
  carries the config of every subsequent send. Same config as the live run → plain push into the
  same run (warm cache); different config or no runtime → new run (killing the live one if any —
  the ADR 0008 "product-command kill" now lives in `sendUserMessage`, not PATCH). PATCH is
  reduced to `title`/`pinned`. UI selectors display the last run's config (fact-derived) and are
  local state until sent.

## Consequences

- The two `resolved_model` columns of `8e54552`/`26040aa` are gone, along with the mutable
  message field, the reply-time status one-shot and the last-assistant backfill — a `run_id` on
  the message plus one write on the run replaces all of it.
- Multi-harness (ADR 0007 cross-kind) needs zero further modelling: segments = group messages by
  their run's kind/model/agent.
- No jsonb at all (amendment 2026-07-05, review pass): `error` — the last one — flattened to
  `error_reason`/`error_ts`, and every timestamp typed `timestamptz` instead of ISO text (the
  store still speaks ISO strings; loads normalise). Anything relational (anchors, the lease)
  is columns/tables. Migrated in place with `ALTER TABLE` (one live conversation preserved).
- Migration: **fresh start** (operator's call — dev-stage data). Old tables dropped; anchors
  start empty, so each pre-existing conversation would have re-seeded once (ADR 0005 floor) had
  any been kept.
- `spawn_count` stays on conversations as the run-id allocator (monotonic, never reused).
- Native titles (amendment 2026-07-05): claude re-titles its terminal tab each turn with an
  AI-generated topic — OSC escapes in the pty stream, the ONLY place it exists (probe: 2.1.x
  writes no transcript summary lines; the sessions-registry name stays mechanical). The
  supervisor reads it off the pty and reports it like `model`; `runs.native_title` records it
  as a fact (re-writable — the topic follows the conversation). The displayed title derives:
  hand-rename (`title_source = 'user'`) > newest titled run > first-message truncation — that
  floor also covers any kind that never titles itself.

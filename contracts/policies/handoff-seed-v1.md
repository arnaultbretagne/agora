# Handoff seed policy `handoff-seed-v1`

- **Revision id:** `handoff-seed-v1` — pinned. This document is normative for it.
- **Owning spec:** [continuity.md — Handoff and seed policy](../../docs/specs/reconciliation/continuity.md#handoff-and-seed-policy)
- **Consumed by:** the opening Handoff renderer (`apps/control-plane/src/handoff/renderer.ts`) and
  every Save that records `seed_policy_revision`.

A Handoff carries the Workstream's own record of `(W, H]` into a native context that does not have
it. It is not a summary and not a transcript: it is a deterministic rendering of canonical facts,
under a revision id that never changes meaning. A policy change gets a new revision id; it never
silently re-seeds a live context or rewrites Save metadata.

## What is rendered from

Canonical facts in the opening range `(W, H]`, in `seq` order, read from the Workstream's own
journal — or from a projector proved complete through `H`. Never from the current head, never from
an unversioned cache, and never from a source that cannot name the facts it derived from. Source
facts keep their identity: the rendering references them, it does not become a second copy of
history that could later disagree with the first.

## Inclusion and order, per fact kind

Facts are folded in `seq` order. Every registered kind is named here; a kind that is not named is
excluded, and registering a new kind requires a new policy revision before it can be included.

| Fact kind | Rendered as |
|---|---|
| `session.opened` | **Excluded.** Bootstrap bookkeeping: it records how a Session was born, not what was said. |
| `session.ended` | **Excluded.** Same reason. Its Session's own content is already in the range on its own merits. |
| `session.provenance` | **Excluded.** Image digests and workload identity are correlations for operators, not context for an agent. |
| `acp.envelope` | Included, decomposed by the frame's own method and direction (below). |

### `acp.envelope`, by method

The payload is the raw NDJSON frame text (ADR 0004). Rendering reads it structurally; it never
re-serializes a frame back onto the wire.

| Frame | Rendered as |
|---|---|
| `session/prompt` request (client → agent) | `user:` followed by the complete assembled text content blocks. |
| `session/update` with `agent_message_chunk` | `agent:` followed by the assembled chunks of one turn, concatenated in arrival order. |
| `session/update` with `user_message_chunk` | `user:` — this is the agent's own replay of a received message; it is included only when no `session/prompt` request in the same range already carries it, so a message is never rendered twice. |
| `session/update` with `agent_thought_chunk` | `thought:`, labelled explicitly as a prior agent thought, capped as below. |
| `session/update` with `plan` | The latest complete plan state at the END of the range only — intermediate plan revisions are superseded, and rendering all of them would spend the budget on states nothing acted on. |
| `session/update` with `tool_call` / `tool_call_update` | `tool:` with the call's title, its final status, and its final result text or resource reference. Intermediate statuses are dropped: only the outcome carries information the next context can use. |
| `session/request_permission` and its response | `permission:` with the request summary and the final decision. |
| `session/new`, `session/resume`, `session/load`, `session/cancel`, `session/set_session_config`, `initialize`, and every response frame not named above | **Excluded.** Transport and bootstrap bookkeeping. |
| A previously delivered Handoff (`session/prompt` whose content is a Handoff resource) | Its **card metadata only** — range, policy revision and digest. Its content is never nested: recursive expansion would grow each Handoff by every Handoff before it. |
| Any frame whose method or update variant this revision does not name | A manifest entry — kind, source `seq`, and SHA-256 of the raw frame. The payload is not injected. An unknown frame is recorded honestly rather than guessed at. |

Everything excluded here remains fully persisted and readable in Agora. Exclusion is about what the
next context is told, not about what is kept.

## Encoding

UTF-8. The rendered resource is plain text with one item per block, each block introduced by its
label above. Line endings are `\n`. No locale-dependent formatting is permitted anywhere: no
localized dates, no locale collation, no locale number formatting. Timestamps, where rendered at
all, are ISO-8601 in UTC with millisecond precision.

The resource is delivered as an ACP **embedded resource content block** with URI
`agora://workstreams/{workstream_id}/handoffs/{command_id}`. A resource *link* is not acceptable:
it does not deliver bytes, and the whole point is that the context receives the content.

## Byte budgets

| Scope | Limit |
|---|---|
| One thought | 8 KiB |
| All thoughts, total | 64 KiB |
| One tool result's embedded text | 32 KiB |
| All tool-result text, total | 128 KiB |
| The whole Handoff resource | 512 KiB |

## Deterministic truncation

Truncation cuts on a Unicode scalar boundary — never mid-code-point — and appends a marker carrying:

1. the original byte length;
2. the SHA-256 of the complete source content;
3. the source fact's `seq`;
4. the literal marker `[truncated by handoff-seed-v1]`.

The digest is what makes a truncated item honest: the next context is told exactly how much it is
not seeing, and the full content stays addressable by its fact.

## Overflow, and `fidelity=degraded`

Essential content is: user messages, agent messages, and the final plan. If essential content alone
exceeds 512 KiB, the renderer:

1. emits a deterministic manifest of every source fact in the range (`seq`, kind, byte length, digest);
2. includes the most recent essential items that fit in 384 KiB, complete;
3. includes, for older items, a bounded preview plus digest and fact reference;
4. marks the Handoff `fidelity=degraded`;
5. requires an explicit user confirmation before dispatch.

No model-generated summary is ever substituted. A summary would make the same range render
differently on a retry, and a Handoff that cannot be reproduced byte-for-byte cannot be proven
delivered.

**The confirmation cannot block a shutdown.** A `fidelity=degraded` Handoff awaiting confirmation
holds up the REFILL that would deliver it and nothing else: an independently requested TURN_OFF
proceeds on its own budget (`OFF-001`), and the unanswered confirmation dies with the Session that
owed it.

## Resource access

Every resource the rendering references — a tool result stored outside the fact, an artifact URI —
must remain authorized and available for the promised retention of the Save that names this policy
revision. A reference that cannot be resolved at render time fails visibly: the render is refused
with the unresolvable reference named. It is never silently dropped, and never replaced by a
placeholder that would make the digest of a lossy rendering look like the digest of a complete one.

## Determinism

For the same range and the same policy revision, rendering is **byte-identical**. Nothing about the
renderer's environment may reach the output: not locale, not wall-clock time, not the target
harness, not the order facts happened to be fetched in. The `handoff` command stores the SHA-256 of
the complete rendered resource, and that digest is what a custody driver later looks for as evidence
of delivery — so a rendering that varies by a single byte is a rendering that can never be proven
delivered.

## What this policy does not promise

It does not promise that the receiving context understands the content, retains it for any length
of time, or can reconstruct native state that was never in the range. Proof of delivery under this
policy is proof that these exact bytes were received — nothing more.

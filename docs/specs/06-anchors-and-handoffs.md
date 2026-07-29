# Anchors and handoffs

## Anchor meaning

For `(workstream_id, agent_id)`, an Anchor states:

> Restoring `custody_snapshot_id` for `session_id` gives this Agent durable context synchronized
> through the inclusive Workstream sequence `synced_through_seq`.

An Anchor is a durable proof, not a guess based on the last sent prompt.

## Anchor invariants

- There is at most one Anchor per Workstream and Agent.
- The referenced Session belongs to the Workstream and Agent.
- The referenced custody snapshot belongs to the Session.
- The referenced custody snapshot is committed and not invalidated.
- Snapshot and Anchor watermarks are identical.
- Watermarks never decrease.
- A watermark cannot exceed the owning Workstream's committed canonical head.
- An Anchor may move to a newer Session of the same Agent only after that Session has a committed
  snapshot.
- An active, unsnapshotted context MUST NOT be advertised as a durable Anchor.

## Advancing an Anchor

1. Select the latest committed Workstream head after the Session is quiescent.
2. Capture custody with that head as watermark.
3. Verify the snapshot checksum and metadata.
4. In one product transaction, upsert the Anchor if the watermark is not stale.
5. Only then dematerialize the Loge.

If the transaction loses a race to a newer Anchor, the snapshot remains unreferenced and is eligible
for retention cleanup.

## Choosing a target Session

When activating an Agent:

1. If an Anchor exists and its Session is resumable under the current registry definition, use it.
2. Otherwise create a new Session for that Agent.
3. The target context watermark is the Anchor watermark or zero.
4. The missing range is `(watermark, current_workstream_head]`.

An explicit UI choice MAY select an older Session, but doing so cannot move the Agent Anchor
backwards.

## Handoff representation

A Handoff is a standard ACP `session/prompt` with:

- `purpose=handoff` in durable command metadata;
- `source_from_seq` exclusive;
- `source_through_seq` inclusive;
- `seed_policy_version`;
- one or more standard ACP content blocks.

The preferred representation is a `ContentBlock::Resource` containing a deterministic, bounded
rendering of the selected Workstream range. The resource URI is stable and descriptive, for example:

```text
agora://workstreams/{workstream_id}/handoffs/{command_id}
```

Correctness MUST NOT rely on the Agent interpreting custom `_meta`.

The builder MUST use a projector version proven complete through `source_through_seq`, or fold the
canonical events directly. It MUST NOT build from a stale Web cache.

## Seed policy

The seed policy is versioned and auditable. It independently selects:

- user and agent messages;
- thoughts;
- plans;
- tool-call summaries or full results;
- permission decisions;
- artifacts/resources;
- previous handoff markers.

The baseline policy MUST include user and agent messages and durable outcomes. Tool calls, thoughts
and large results MUST have explicit inclusion rules and size budgets; they are never silently
excluded because the UI collapsed them.

The Handoff command records the policy version and content digest.

The concrete baseline is
[`handoff-v1`](../../contracts/policies/handoff-seed-v1.md).

## Avoiding duplicate product history

The source events remain the only product representation of their original content. The target
Session receives a new Handoff prompt, rendered in the Workstream as one inspectable synchronization
card.

The projector MUST NOT expand the Handoff back into duplicate copies of every source item. If the
Agent echoes the resource, that echo remains a target-Session event correlated to the Handoff turn.

## Example

```text
Claude Anchor = C
Workstream head after Codex = D

restore Claude custody(C)
ACP session/resume(claude_acp_session_id)
handoff source range (C, D]
continue Claude from synchronized context
```

On the next Claude suspension, capture a snapshot at the new head and advance the Claude Anchor.

## Failure handling

- Resume fails before Handoff: fail or retry resume; do not advance anything.
- Handoff dispatch is uncertain: apply the prompt-delivery ambiguity rules; never blindly resend.
  Any dispatch attempt proven not accepted remains attached to the same durable
  command/idempotency key.
- Handoff prompt returns an error: target remains at the old durable Anchor; surface failure.
- Agent completes Handoff but capture later fails: the live context is usable, but its durable Anchor
  remains old. A crash restores the old snapshot and replays the same missing range.
- Source range exceeds size policy: apply the policy's deterministic manifest/previews and resource
  links, record truncation metadata, and require user confirmation when fidelity is degraded; never
  substitute an unrecorded model summary.

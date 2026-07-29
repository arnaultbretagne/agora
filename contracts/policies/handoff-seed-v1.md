# Handoff seed policy v1

This policy is normative for `seed_policy_version=handoff-v1`.

## Ordering

Items are rendered in canonical Workstream sequence order. A target Session's own Handoff card is
not recursively expanded.

## Included content

| Item | Representation |
|---|---|
| User messages | Complete assembled ACP content blocks |
| Agent messages | Complete assembled ACP content blocks |
| Thoughts | Emitted content, capped as below and explicitly labelled as prior-Agent thought |
| Plans | Latest complete plan state at the end of the source range |
| Tool calls | Tool title/name, status, input summary, final result/resource references |
| Permission interactions | Request summary and final user/policy decision |
| Usage/config/session info | Omitted except active model/mode/config facts relevant to interpreting output |
| Terminals | Command/title/exit status and retained resource reference; no unbounded raw output |
| Unknown ACP updates | Manifest entry with type, source position and digest; raw payload not injected by default |
| Previous Handoffs | Card metadata only; their copied resource content is not nested |

All source content remains fully persisted and visible in Agora regardless of this seed selection.

## Byte budgets

- Individual thought: 8 KiB UTF-8.
- Total thoughts: 64 KiB.
- Individual tool result embedded text: 32 KiB.
- Total tool-result embedded text: 128 KiB.
- Total Handoff resource: 512 KiB.

Truncation occurs on a Unicode boundary and adds:

- original byte size;
- SHA-256 of complete source content;
- Workstream item/resource reference;
- explicit `[truncated by handoff-v1]` marker.

## Overflow

Essential content is user messages, agent messages, final plan and durable outcomes. If essential
content alone exceeds 512 KiB:

1. produce a deterministic manifest of all source items;
2. include complete most-recent essential items fitting 384 KiB;
3. include bounded previews plus digests/resource references for older items;
4. mark the Handoff `fidelity=degraded`;
5. require explicit user confirmation before dispatch.

No model-generated summary is silently substituted because that would make retry content
non-deterministic.

## Determinism

For the same source range and projector version, rendering MUST be byte-identical. The command stores
the SHA-256 of the complete Handoff resource.

Locale, wall-clock time, UI collapse state and target Agent MUST NOT change rendering.

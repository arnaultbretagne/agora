# 006 — `CAPABILITIES`

`CAPABILITIES` reconciles the Pod-bound OneCLI Agent against the complete exact grant set. It
compares authority at OneCLI's boundary, preserving every right even when it completes no named
capability ([ADR 0010](../../adr/0010-capabilities-are-onecli-grants.md)).

## Inputs

- [`intent.capabilities`](001_intent.md), compiled once for this evaluation to the exact set `D`;
- [`observation.grants.attached`](002_observation.md), abbreviated `A`;
- [`observation.grants.effective`](002_observation.md), abbreviated `E`.

Set representation, equality and compilation are defined by
[Capabilities and OneCLI](../10-equipment-and-broker.md#exact-grant-comparison). Compilation is
trusted resolution, not an Observation. `D`, `A` and `E` contain authorizations, not capability ids.

## Rules

| Rule | Conditions | Result |
|---|---|---|
| `CAPS-001` | `A ∪ E ⊄ D` | [`ACTION(REVOKE)`](003_verbs.md#revoke) |
| `CAPS-002` | `A ∪ E ⊆ D ∧ D ⊄ A` | [`ACTION(GRANT)`](003_verbs.md#grant) |
| `CAPS-004` | `A = D ∧ E ⊂ D` | `HOLD` |
| `CAPS-003` | `A = D ∧ E = D` | `PASS` |

The partition is: excess attached/effective authority; no excess but missing attachments; correct
attachments with restricted/pending effectiveness; exact attached and effective authority. Stable
rule ids are retained even when a new row is inserted.

Revocation precedes additions. A half-removed capability remains visible through its remaining
authorizations. An attachment masked by an organization restriction is still removed if unwanted,
so lifting that restriction cannot revive stale access.

`CAPS-004` waits on OneCLI effectiveness or on the owner of the external restriction. Its work row
remains active, work admission stays closed, and the engine watches/rechecks OneCLI with backoff.
Repeating attachment or broadening policy cannot resolve this case. Permanent owner denials are
surfaced with their remediation; they are not reported as successful convergence.

Direct Agent edits are drift and are reconverged. Organization restrictions are external authority
and Agora never rewrites them to satisfy Intent. `CAPS-003` passes to the next ordered rule.

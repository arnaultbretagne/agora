# 001 — Intent taxonomy

`intent.*` contains desired values from the complete immutable Intent selected by `intent_seq`.
Intent is never interpreted as a patch and never proves that its requested state was realized.

Every Intent field used by a reconciliation rule MUST be registered here with its values and exact
meaning.

| Field | Values | Meaning |
|---|---|---|
| `intent.power` | `on`, `off` | Whether a live execution footprint should exist. |
| `intent.harness` | one `harness_id` from the reviewed catalogue | Which reviewed harness integration the live Pod must run. A `harness_id` selects one trusted image pinned by digest ([ADR 0006](../../adr/0006-complete-harness-images.md)); it names an integration for provenance and Anchor selection, not a process or runtime identity. |
| `intent.capabilities` | a set of capability ids from the reviewed catalogue, possibly empty | Which capabilities the live execution must hold. Each entry is realized as OneCLI grant(s) on the Workstream's Agent ([ADR 0010](../../adr/0010-capabilities-are-onecli-grants.md)); the set is flat and every entry is reviewed independently. |

Later rules extend this registry when their Intent fields are specified.

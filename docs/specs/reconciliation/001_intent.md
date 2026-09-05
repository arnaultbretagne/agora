# 001 — Intent taxonomy

`intent.*` contains desired values from the complete immutable Intent selected by `intent_seq`.
Intent is never interpreted as a patch and never proves that its requested state was realized.

Every Intent field used by a reconciliation rule MUST be registered here with its values and exact
meaning.

| Field | Values | Meaning |
|---|---|---|
| `intent.power` | `on`, `off` | Whether a live execution footprint should exist. |
| `intent.harness` | one `harness_id` from the reviewed catalogue | Which reviewed harness integration the live Pod must run. A `harness_id` selects one trusted image pinned by digest ([ADR 0006](../../adr/0006-complete-harness-images.md)); it names an integration for provenance and Anchor selection, not a process or runtime identity. |
| `intent.capabilities` | a set of capability ids from the reviewed catalogue, possibly empty | The complete named authority requested for execution, including any required model/provider access. The trusted compiler resolves the whole set to exact OneCLI grants on the Pod's Agent ([ADR 0010](../../adr/0010-capabilities-are-onecli-grants.md)); harness/model selection adds no implicit grant. |
| `intent.model` | exactly one model id the harness definition advertises | Which model the live Session runs, applied as the session's `model` configuration option. Validity is against the reviewed per-harness model catalogue for `intent.harness`. |
| `intent.effort` | exactly one effort level valid for `intent.model`: `default`, or a level that model supports | Which reasoning effort the live Session runs, applied as its `effort` configuration option. An Intent whose effort is not valid for its model is invalid and is rejected when authored, not reconciled. |
| `intent.persona` | `default` | **Frozen.** The reviewed fresh/restore path must establish default persona; an echoed request value is not proof. Persona selection remains disabled until an effective application/readback contract is registered. No rule infers it from an absent ACP option. |

Later rules extend this registry when their Intent fields are specified.

Catalogue/compiler revisions are trusted resolution provenance, not extra public Intent fields.
Every worker uses the same selected revision set under the [engine contract](engine.md). On Intent
authoring validates executable model/effort/authority combinations. For off, those settings are
inapplicable to realization: a complete request may retain previously accepted selections, without
depending on OneCLI availability or newly enabled catalogue entries to authorize extinction.

# 001 — Intent taxonomy

`intent.*` contains desired values from the complete immutable Intent selected by `intent_seq`.
Intent is never interpreted as a patch and never proves that its requested state was realized.

Every Intent field used by a reconciliation rule MUST be registered here with its values and exact
meaning.

| Field | Values | Meaning |
|---|---|---|
| `intent.power` | `on`, `off` | Whether a live execution footprint should exist. |

Later rules extend this registry when their Intent fields are specified.

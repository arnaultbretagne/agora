# Reconciliation specification

This directory defines the ordered decision model that realizes a Workstream's complete Intent
from fresh Observations.

Read the files in numeric order:

1. [`000_taxonomy.md`](000_taxonomy.md) defines the input namespaces, rule format, result grammar
   and tick semantics once for the whole decision model.
2. [`001_power.md`](001_power.md) defines the first rule.

Every later rule receives the next numeric prefix. A rule file contains one decision table; it does
not restate the engine semantics or the contracts of unrelated rules.

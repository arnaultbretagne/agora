# Reconciliation specification

This directory defines the ordered decision model that realizes a Workstream's complete Intent
from fresh Observations.

Read the files in numeric order:

1. [`000_taxonomy.md`](000_taxonomy.md) defines the common rule format, result grammar and tick
   semantics.
2. [`001_intent.md`](001_intent.md) defines the Intent taxonomy.
3. [`002_observation.md`](002_observation.md) defines the Observation taxonomy.
4. [`003_verbs.md`](003_verbs.md) defines the closed action-verb catalogue.
5. [`004_power.md`](004_power.md) defines the first rule.

Every later rule receives the next numeric prefix. A rule file contains one decision table; it does
not restate the engine semantics or the contracts of unrelated rules.

# workflows

`ci.yml`: on every push to the base or to a `feat/`, `fix/` or `chore/` branch, and on every PR
to the base, typecheck and tests of every workspace. On a push, it builds, tries and publishes
by digest the three images (`agora-lab`, `agora-harness-mock`, `agora-harness-claude-code`),
tagged with the commit. The digest is in the run's summary.

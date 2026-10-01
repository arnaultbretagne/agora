# reliability

What Agora has been shown to do, and how strongly: the evidence behind each acceptance case of
the specs, and the failures nothing has shown yet. Consulted to know what can be relied on.

## What goes here

One document per subject that has acceptance cases, named like its spec, in three parts:

| Part | Content |
| --- | --- |
| Runs | One row per run: its ID, date, commit, levels and environment — cluster, versions, images, settings that matter to the cases. |
| Cases | One row per acceptance case and run that exercised it: case, failure, level, run, verdict, observed. A case no run has shown still has its row, `not verified`. |
| Not covered | Failures of the subject that no case produces, or no run has shown, each with its issue. |

## Vocabulary

**Level** — where it ran.

| Level | What is real |
| --- | --- |
| `unit` | Code only: no process, database or network. |
| `local` | Real processes on one machine — PostgreSQL, the bridge, the mock adapter; Kubernetes is simulated. |
| `cluster` | g4 under Kata, with Agent Sandbox and the gateway; harnesses without a model call. |
| `live` | A real harness and model, through the gateway; billed. |

**Failure** — how it was produced.

| Value | Meaning |
| --- | --- |
| `—` | A nominal case: nothing fails. |
| `real: …` | The failure itself happened — a process exited or was killed, a connection was cut, PostgreSQL stopped, an adapter died, a deadline passed. The cell says which, and from which side. |
| `simulated: …` | A stand-in, named by its mechanism: `sql-trigger`, `stub` (a function replaced), `forced-state` (the test sets internal state), `synthetic-event` (the test emits an event or a message), `fake-kube` (Kubernetes simulated). |

**Verdict** — what the test asserts, against Expected.

| Verdict | Meaning |
| --- | --- |
| `proven` | Every clause of Expected is asserted, with the failure produced as the row says. |
| `partial` | A clause is only observed, or not checked; the cell says which. |
| `not verified` | No run shows it. |

## What a test must do to count

1. **Prove one case.** Its name starts with the case ID. A case may need several tests; a test
   never claims several cases.
2. **Assert every clause of Expected**, refusal reasons and counts included. Printing a value is
   not asserting it.
3. **Pair a negative assertion with a positive control.** "Nothing is renewed" counts only next
   to a test showing that a renewal would have been seen.
4. **Produce the failure for real** when the level allows it. Otherwise, go through a fault
   point the component declares for tests — never a patched shared prototype or private state
   written by the test. The row names the mechanism.
5. **Own its state**: its database, its executions. No cleanup writes history.
6. **A `cluster` or `live` run writes its complete output** — commit, images, versions,
   observations — and nobody edits it by hand.

## Rules

- **Observed comes from a run's output**, never from reading the code.
- **The verdict compares assertions with Expected.** A good observed value does not upgrade it.
- **A row belongs to its run's commit.** Changing a test leaves its earlier rows as evidence for
  the old test, not the new one.
- **No plans.** A gap is `not verified`, or listed under Not covered, with its issue.
- **Raw output stays with the pull request that produced it.** Only fixtures that a test replays
  are kept in the repository.

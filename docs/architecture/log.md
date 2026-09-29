# The log

The log is what Agora owns: the user's commands and the ACP exchanges, kept independently of the
lifetime of processes and infrastructure, and the views the client displays. What follows
describes the intended behaviour, still a proposal where marked; the open questions close the
document.

## Workstreams and Sessions

Proposal: keep two simple product concepts.

- A **Workstream** groups a piece of work and its ordered history.
- A **Session** attributes exchanges to a concrete execution of a harness.

Reconnecting to the same live context keeps this attribution. A new process or
context must be identified explicitly; a sandbox's stable name is not enough to
prove continuity.

The requested configuration and the one actually applied stay distinct. This
requires neither a full Intent object on every change nor a generic reconciliation
engine. The exact boundary of Sessions when the model changes is still to be
decided.

The log keeps the complete accepted ACP exchanges, including their metadata.
Assembled messages and tool states are views that can be rebuilt. Infrastructure
credentials are not conversation data. The log lives in PostgreSQL.

## Handling a message

1. Authorize the user on the Workstream and deduplicate their request.
2. Check the target Session, the ACP connection and incompatible commands in progress.
3. Durably record the command before sending it.
4. Send on the existing connection; log the exchanges received and feed the interface.

The usual path does not re-read Kubernetes, the grants and the native transcript before
each message. Connection events and operation responses update what Agora knows of
its interaction with the harness.

An open connection is not proof of progress. A timeout makes the stall visible; it
proves neither that the command failed nor that it had no effect.

## Commands and recovery

Proposal: a single active turn per Workstream. Configuration changes, sends and
stops share an explicit ordering rule. Cancellation can interrupt the active turn;
a late cancellation must not hit the next one.

After a crash, Agora finds the unresolved commands and their targets again. A retried
sandbox request must find the same resource when its creation succeeded despite
the lost response.

For ACP, "saved", "possibly sent" and "done" are distinct. A lost response does
not trigger an automatic resend. Agora looks for proof from the same context if the
harness allows it, otherwise it exposes the uncertainty. An Agora command id does
not guarantee deduplication on the harness side.

This targeted recovery is necessary. It does not bring back a loop that constantly
re-evaluates every dependency and the whole desired configuration.

## Stop and cleanup

Agora closes new sends, requests cancellation if needed, then stops renewing the deadline:
Agent Sandbox destroys the sandbox at most one lease later, and the execution's token expires on
its own. A stop is written on the claim, so it survives an Agora restart; saving the context
never delays it.

Expiry and the infrastructure-side reaper also clean up resources Agora has lost
track of. They do not replace the handling of an explicit stop request, and do not
guarantee instant termination.

Before a replacement is allowed, it must be decided which proof prevents the old
execution from continuing to modify files or call services. A resource missing from
the API is not enough in case of a network partition. If the infrastructure does not
provide this guarantee, the replacement stays blocked or a weaker guarantee must be
explicitly accepted. Agora will not build its own fencing system.

## Continuity of work

Three kinds of data have different guarantees:

| Data | Proposed guarantee |
| --- | --- |
| Product history | Durable once accepted by Agora. |
| Harness native context | Resumable only if the integration demonstrates it. |
| Files and artefacts | Not kept by Agora: the sandbox has no persistent storage, and the agent pushes what must last (code, a note). |

The anchor keeps the harness's native files when a Pod ends (`executions.md`); restoring it
opens a new session. If reliable native resume is not available, Agora keeps the history and
explicitly offers a new context with the chosen elements. It does not present this operation as
an exact restore.

Internal compaction belongs to the harness. Agora does not try to prove after each
message that the model still has the whole history.

## Visible failures

| Incident | Expected reaction |
| --- | --- |
| Browser disconnected | The execution can continue; the interface re-reads the history on return. |
| Agora restarts | Find the target and the commands again; no blind resend. |
| ACP disconnects during a turn | Targeted reconnection; result uncertain until it is established. |
| Harness or sandbox lost | History kept; resume according to the data actually available. |
| The gateway refuses or does not respond | Error on the operation, with no automatic escalation of grants. |
| Log storage unavailable | Suspend new sends and apply bounded backpressure; do not claim durability that is not there. |
| Old execution cannot be stopped | Cleanup left to the infrastructure; no replacement announced as safe without proof. |

## Open questions

1. The functional scope and the definition of Sessions.
2. Workspace storage and the resume actually promised for each harness.
3. Command ordering, recovery of uncertain sends and the buffering limits when the log is
   unavailable.
4. User access, ACP permissions and data retention.

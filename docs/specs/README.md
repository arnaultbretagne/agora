# specs

The contracts Agora is built against: what each component must do, exactly. A spec is
consulted when implementing or checking, not read end to end.

## What goes here

One document per subject, with, as they apply:

| Part | Content |
| --- | --- |
| Header | The versions it is written against (Agent Sandbox, agentgateway, a library). |
| Actors and interfaces | Routes, messages, fields, annotations, environment, with their real names. |
| Rules | States, deadlines, limits, error answers. |
| Acceptance cases | Each case with its ID and what is expected. What was shown, and how, is in `reliability/`. |
| To be specified | What the contract does not settle yet. |

## Rules

- **Normative.** Every statement is checkable against the code or a live run.
- **Cases have stable IDs**: the subject's letter and a number — `E` for executions, `C` for
  credentials, `L` for the log, `U` for the client, `F` for the flows. An ID is never reused for another case.
- **Expected states every clause a test must assert**: values, counts, refusal reasons.
- **No measurements.** Evidence lives in `reliability/`.
- **No reasons.** Why a rule exists belongs in the subject's ADR; how it fits together, in
  `architecture/`.

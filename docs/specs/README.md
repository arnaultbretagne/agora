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
| Cases to validate | Each case, what is expected, and what was measured, with where and when. |
| To be specified | What the contract does not settle yet. |

## Rules

- **Normative.** Every statement is checkable against the code or a live run.
- **The measured column is filled from real runs**, dated; never from expectations.
- **No reasons.** Why a rule exists belongs in the subject's ADR; how it fits together, in
  `architecture/`.

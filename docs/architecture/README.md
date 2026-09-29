# architecture

How Agora fits together, subject by subject: the actors, the concepts, how a flow unfolds.
Written to be read end to end by someone who does not know the system yet.

## What goes here

- `overview.md`: what Agora is for, its foundations, who owns what, how it behaves, and the open
  questions.
- One document per subject, explaining it: who does what, the main flows, what follows from
  them.

## Rules

- **Explain, do not specify.** Exact routes, fields, values and cases belong in `specs/`; the
  reasons and the options tried belong in `adr/`.
- **A diagram per flow** when the flow has more than two actors, in Mermaid, kept minimal.
- **Short.** If a section grows into a list of rules, it is a spec.

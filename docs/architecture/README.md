# architecture

How Agora fits together, subject by subject: the actors, the concepts, how a flow unfolds.
Written to be read end to end by someone who does not know the system yet.

## What goes here

- `_overview.md`: the map, read first (the underscore sorts it first). What Agora does, its
  components and what each holds, the prerequisites, where trust stops, a message end to end.
  It stays at the components' boundaries.
- One document per subject, explaining its inside: who does what, the main flows, what follows
  from them, and its open questions.

## Rules

- **Explain, do not specify.** Exact routes, fields, values and cases belong in `specs/`; the
  reasons and the options tried belong in `adr/`.
- **A diagram per flow** when the flow has more than two actors, in Mermaid, kept minimal.
- **Short.** If a section grows into a list of rules, it is a spec.

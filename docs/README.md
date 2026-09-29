# docs

Agora's documentation, in three folders that each answer one question.

| Folder | Question | Content |
| --- | --- | --- |
| `architecture/` | How does it work? | How the system fits together, subject by subject; read end to end. Start with `overview.md`. |
| `specs/` | What exactly must be implemented? | The contracts: routes, fields, states, rules, validated cases; consulted, not read end to end. |
| `adr/` | Why is it built this way? | One decision per record: context, decision, what we tried, consequences. |

A subject can appear in all three — `executions.md` in `architecture/` and `specs/`, the
executions ADR in `adr/` — each document saying only what its folder is for.

## Rules

- **One subject, one document per folder.** The file name says the subject.
- **No links between files.** Names and layout are enough to find a document; a link ends up
  dead. Cite a document by its name.
- **Written as Agora's documentation.** What is true of Agora, not the state of a work in
  progress: no "rewrite", no "this branch", no "for now".
- **Language:** English.
- **Form:** prose and tables, with the real names of things; Mermaid diagrams when they help,
  kept minimal. No code.

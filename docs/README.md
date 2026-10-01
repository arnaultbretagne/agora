# docs

Agora's documentation, in four folders that each answer one question.

| Folder | Question | Content |
| --- | --- | --- |
| `architecture/` | How does it work? | How the system fits together, subject by subject; read end to end. Start with `_overview.md`. |
| `specs/` | What exactly must be implemented? | The contracts: routes, fields, states, rules, acceptance cases; consulted, not read end to end. |
| `adr/` | Why is it built this way? | One decision per record: context, decision, what we tried, consequences. |
| `reliability/` | What have we verified, and how? | For each acceptance case: the evidence, its level, how a failure was produced, the verdict. |

A subject can appear in all four — `executions.md` in `architecture/`, `specs/` and
`reliability/`, the executions ADR in `adr/` — each document saying only what its folder is for.
Specs say what must happen; reliability says what was shown to happen. Test setup and
assertions live in the tests; raw run output lives with the pull request that produced it.

## Rules

- **One subject, one document per folder.** The file name says the subject.
- **No links between files.** Names and layout are enough to find a document; a link ends up
  dead. Cite a document by its name.
- **Written as Agora's documentation.** What is true of Agora, not the state of a work in
  progress: no "rewrite", no "this branch", no "for now". Dated evidence is a fact and stays;
  a plan is not, and goes to an issue.
- **Language:** English.
- **Form:** prose and tables, with the real names of things; Mermaid diagrams when they help,
  kept minimal. No code.

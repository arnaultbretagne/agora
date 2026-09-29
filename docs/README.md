# docs

Agora's design: one document per subject, which says how it works, and the architecture
decisions in `adr/`, which say why. Start with `design.md`.

## What goes here

- **One document per subject** — the product, executions, credentials, the interface. It
  describes the contract: the actors, the exchanges, the rules, the validated cases and what
  remains to be specified.
- **One ADR per architecture decision**, in `adr/`, following that folder's recipe.

## Rules

- **One subject, one document.** The file name says the subject; a new subject makes a new file,
  not a section added elsewhere.
- **No links between files.** Names and layout are enough to find a document; a link ends up
  dead. Cite a document by its name.
- **Written as Agora's documentation.** What is true of Agora, not the state of a work in
  progress: no "rewrite", no "this branch", no "for now".
- **Language:** English.
- **Form:** prose and tables, with the real names of things; Mermaid diagrams when they help,
  kept minimal. No code.

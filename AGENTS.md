# Agents

Instructions for coding agents working in this repository.

- **Language:** everything in this repository is in English — code, comments, docs, ADRs, UI
  strings, log and error messages, commit messages, pull requests — whatever language the
  conversation is in.
- **Docs:** `docs/README.md` sets the rules for documents, `docs/adr/README.md` for ADRs.
- **Tests and evidence:** `docs/reliability/README.md` sets what a test must do to count as
  evidence, and how evidence is recorded.
- **Branches:** `README.md` sets how work reaches the base branch.
- **Checks:** `npm run check` must pass before a push.
- **CI:** never write under `.github/workflows/`; the GitHub App agents push with cannot. A harness
  image is a folder (`harnesses/README.md`). A need the workflows do not cover (a secret, a trigger,
  a permission) is a question for the person, not a file to leave in a branch.

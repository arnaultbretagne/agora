# adr

Agora's architecture decisions. An ADR explains why Agora is built this way; how it works is
described in the subject's own document, in `docs/`.

## When to write one

For a choice that commits us and would be costly to undo: a component, a dependency, a trust
boundary, an exchanged format. Not for an implementation detail, nor for what the subject's
document already explains.

## What we want to read

| Section | Content |
| --- | --- |
| Header | Status and date. |
| Context | The problem and its constraints, without the solution. |
| Decision | What is decided, in a few checkable points; a diagram when it helps. |
| Why | What the decision brings, with the measurements that back it. |
| What we tried | Each option tried or studied: what it was, what we found, why we dropped it. |
| Consequences | What the decision costs or imposes next. |

## Rules

- **Name:** a four-digit number and a short title; the title states the decision.
- **Status:** *proposed* while under review and nothing depends on it; *accepted* once it binds
  the code.
- **Living:** an ADR states the decision in force. When the decision changes, rewrite it; git
  keeps the history.
- **Sourced findings:** each finding says where it comes from — a measurement (where, when),
  code read (version), documentation (quoted as such).
- **Form:** short sentences, tables, the real names of things; Mermaid diagrams welcome, kept
  minimal. No code, no links to other files: names and layout are enough to find them.

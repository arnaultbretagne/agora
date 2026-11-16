# Roles

Contract to implement: an agent started as a role — a card of the repository saying who it is and
what it works with by default. A person names a role when a Workstream starts (`assistant-ui.md`,
"Roles"); an agent names one when it delegates (`delegation.md`, `agent_type`). A team is a `lead`:
a role whose card has it start the others, by delegation.

**A role is the Workstream's, set by its first execution and kept. Agora gives its persona to the
agent itself, ahead of the first message of every Session that opens with no history; the thread
and the title stay those of the person's words, or the delegator's.**

## Cards

| Name | Value |
| --- | --- |
| File | `roles/<role>.md`: a front matter of `key: value` lines between two `---` lines — `role`, `summary`, `harness`, `model`, `effort`, `access` — then the persona in Markdown. |
| Roles | `lead`, `dev`, `sre`, `judge`. |
| `summary` | What the role does, in a line: what a person or an agent choosing it reads. |
| `harness`, `model`, `effort` | What the role works with by default. `default`, or no value: the pool's own. |
| `access` | Profiles, separated by commas: what a person's draft starts with when the role is picked, beside its own (`assistant-ui.md`, "Roles"). A card gives no right by itself: a Create names its profiles, and `spawn_agent` its `rights`. |
| Read | By the server at its start, from `ROLES_DIR`, its image's `roles` by default. A card that cannot be read stops the start, saying which. |
| `GET /api/config` | `roles`: each card's `role`, `summary`, `harness`, `model`, `effort` and `access`, in the order of their names. Never a persona. |

## Naming a role

| Element | Rule |
| --- | --- |
| A person | The Create of a Workstream's first execution carries `role` (`log.md`, "Commands"). `unknown_role`: no card of that name; nothing is written. |
| An agent | `spawn_agent`'s `agent_type` (`delegation.md`, "A delegation"): the delegate's Create carries it as `role`. |
| Kept | The role of a Workstream is its first Create's. A later Create carries none: the log gives it the Workstream's. One naming another role is refused, `role_set`. |
| Shown | The Workstream view and its row give `role`, absent when it has none (`log.md`, "The Workstream view"). |
| Settings | A Create resolves its opening settings as any (`log.md`, "Commands"): a role adds none. Its defaults are applied by who writes the Create — the client's draft, the delegation engine —, each of them replaced by what the person picked or the call named. A role's model and effort go with its own harness: on another, that pool's defaults. The effort goes under the id the pool gives it — `effort`, or `reasoning_effort` —, in its defaults or in what its last Session offered. |

## The persona

| Element | Rule |
| --- | --- |
| Given | With the first prompt that is not a command — a first text block starting with `/` runs one, and must stay first — of every execution whose Session does not hold it: a new one (`session.opened`, `origin` `new`), or one restored from an anchor none of whose executions, down the anchors each restored, was given it. |
| The block | One text block of Agora's, ahead of every other, the catch-up included: `` From Agora, not the person: your role, `<role>`. ``, a blank line, the card's persona. Marked `_meta` `agora.bretagne.dev/role` with the role's name. |
| Once | Dispatched, never again in that execution, nor in one that restores its anchor. Never dispatched, the next execution gives it. |
| Left out | Of the `user` element, whose `role` says it came with one; of the Workstream's title — an agent titling itself with that block's first line is not followed (`log.md`, "The Workstream view") —; of the person's lines in a transcript (`search.md`) and in the exchanges a catch-up gives. |
| The card | The one the server holds when the prompt goes: a card changed reaches the next new Session. A role whose card is gone gives no block, and its Workstream goes on. |
| Into a turn | A message sent into a running turn carries none: the turn's first prompt did. |

## A team

A `lead` is a role as any other. Its card has it plan, wait for the person's word, start a `dev`
or an `sre` for each feature and a fresh `judge` for each verification, and end by saying what
ships. Every one of those is a delegation, under delegation's own rules and no other
(`delegation.md`): rights within the lead's start at once, those beyond wait for the person's
approval; three delegates at once; ten `send_message` to one delegate until the person writes again.

A `judge` is a tool of the lead's as any other, and Agora makes none of its verdicts a condition.
What a pull request needs before it merges is GitHub's rule (`merge.md`): the reviewer's approval,
which a judge given the right to review that repository — `github:owner/repo:review`
(`credentials.md`) — gives as its verdict, and nobody else on a team can.

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| P1 | The server started on the repository's cards; on a directory holding a file that is no card; `GET /api/config` | `lead`, `dev`, `sre` and `judge`, each with its summary, harness, model, effort and access, no persona; the start refused, naming the file; `lead`'s `access` holds `agora:delegate`. |
| P2 | A Create carrying `role`, with a message; its Session opens; a Workstream started with no role | Accepted; one `session/prompt`: Agora's block first, marked with the role's name — its line, then the persona —, then the message; the `user` element the message alone, with `role`; the title the message's first line; the view and the row give `role`. With no role: the message alone, no `role` anywhere. |
| P3 | A Create naming no card's role; one whose `role` is no string | `unknown_role`; `invalid_create`; no entry, no execution. |
| P4 | A second message in that Session; a first message that is a command, a plain one sent into its running turn, then a plain one | The block with the first alone; none into the turn, the block with the next prompt. |
| P5 | The execution ended, its anchor restored by the next; a Workstream whose only anchor was lost, its next execution opening a new Session with a catch-up | No block with the first; with the second, the block, then the catch-up, then the message. |
| P6 | A later Create carrying no role; one naming another role; one naming the same; one naming a role in a Workstream started with none | The Workstream's role, its block given to the new Session; `role_set`; accepted; `role_set`. |
| P7 | A first message that is a command, then a plain one | The command alone, first; the block with the next. |
| P8 | An agent titling itself with the block's first line | The title stays the message's first line. |
| P9 | A Workstream whose role has no card any more, a new Session opening | No block; its message sent as any; its role still its own. |
| P10 | Its transcript, and the exchange a catch-up gives of it | The person's lines the message alone: none of the persona. |
| P11 | Live: a person's Workstream started as `lead`, with `agora:delegate` and write access to a repository of the cases', its goal a one-line change there; "go" once it has planned | Its role's block ahead of its first prompt; a plan, and nobody started before the word; then a `dev` and after it a `judge`, each started by `spawn_agent`, each a sub-stream with its role; its last message naming the pull request. |
| P12 | A first message that is a command, the execution ended, its anchor restored by the next, then a plain message; that execution ended, its anchor restored in turn | The block with the plain message, the restored Session never having been given it; none with the third execution's. |

## To be specified

- A role's persona given again once its harness has compacted it away.
- A role changed in the course of a Workstream.
- A Workstream's role on its row in the list, and on a delegate's line in its delegator's thread.
- A team's bounds beyond delegation's own: how many verifications, how long a run.

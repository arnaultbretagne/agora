# roles

The role cards: who an agent started as a role is (`docs/specs/roles.md`). The server reads them at
its start, from its image.

## Writing a card

One file per role, `<role>.md`:

| Part | Content |
| --- | --- |
| Front matter | `key: value` lines between two `---` lines. `role`: its name, the file's. `summary`: what it does, in one line — what a person or an agent choosing it reads. `harness`, `model`, `effort`: what it works with by default; `default`, or nothing, leaves it to the pool. `access`: the profiles a person's draft starts with when the role is picked, separated by commas. |
| The persona | Markdown, under a heading that is the role's name: who the agent is, what it is judged on, how it works, how it reports. Written to the agent, in the second person. |

A card speaks of the tools its agent has under their names — `spawn_agent`, `send_message` — and of
no mechanism that is not its agent's to use.

## Check

`npm test -w @agora/log` reads every card (`packages/log/test/roles.test.ts`, P1): one that cannot
be read stops the server's start.

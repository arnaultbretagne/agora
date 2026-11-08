# Merge

Contract to implement: the merge card. An agent that wrote a pull request proposes its merge; the
person merges it from the card, in one click. Written against GitHub's REST API (2022-11-28).

**GitHub holds the rule, Agora only the click. `agora-contributor` writes, `agora-reviewer` approves —
its approval is the one review `main` requires — and only the operator may update `main`
(`credentials.md`, "GitHub identities"). The card shows what GitHub says of the pull request, and
offers Merge only when GitHub would merge it without the operator's bypass.**

```mermaid
sequenceDiagram
    participant A as Agent
    participant G as Agora
    participant H as GitHub
    participant P as Person
    A->>G: propose_merge(repo, number)
    G->>H: read the pull request
    G-->>A: proposed
    G->>P: the card, its state read again while it waits
    P->>G: Merge
    G->>H: read again; ready: squash merge, as the operator
    G-->>A: merged, or why not, as Agora
```

## The proposal

| Element | Rule |
| --- | --- |
| The tool | `propose_merge` on Agora's MCP server (`mcp.md`): `repo`, `owner/name`; `number`, the pull request's. Listed to an execution holding a repository's write (`github:owner/repo:write`), for those repositories only: another is `not_allowed`. |
| What Agora reads | The pull request, through the gateway, with its own grant (`credentials.md`, "Agora's own profiles": `merge`): open, its title, URL, base and head. Not found: `not_found`; closed or merged: `not_open`. Nothing the card shows comes from the agent. |
| The card | An Ask of Agora's own, `kind` `merge`, in the caller's Workstream (`log.md`, "Commands"): its title the pull request's; its text the link, `base ← head` and its author; one option, Merge (`allow_once`); `repo`, `number`, `url`. No expiry. Another question pending: `question_pending`. |
| The answer | At once: `proposed <owner/name>#<number>: the person merges it from the card; what happens comes back to you as a message from Agora`. The agent goes on or ends its turn: nothing holds the call. |

## The card

| Element | Rule |
| --- | --- |
| Its state | Read from GitHub while it is pending: when it shows, then every 20 s, through `GET /api/workstreams/{id}/merge` (`log.md`, "HTTP"), at most once every 10 s per card. |
| Merge | Open when the state is `ready`, closed otherwise, the state saying why. |
| Writing | A Write of the person's while the card waits cancels it (`question.cancelled`), then goes as any message: the agent reads the words, and proposes again when it has done what they ask. |
| One at a time | One question per Workstream (`log.md`, "Commands"). |

| GitHub says (`mergeable_state`) | The state | What the card says |
| --- | --- | --- |
| `clean` | `ready` | Ready to merge. |
| `blocked`, no approval on the head | `review` | Waiting for a review. |
| `blocked`, otherwise | `blocked` | Blocked by the repository's rules. |
| `unstable` | `checks` | Checks failing or running. |
| `dirty` | `conflicts` | Conflicts with the base. |
| `behind` | `behind` | Behind its base. |
| `draft` | `draft` | A draft. |
| `unknown` | `computing` | GitHub is computing; read again. |
| Closed, merged | `closed`, `merged` | Closed. Merged. |

## The merge

| Element | Rule |
| --- | --- |
| The click | The Answer (`log.md`, "Commands"). Agora reads the pull request again: `ready`, it merges its head, squash, as the operator (`PUT …/pulls/{number}/merge`, `merge_method` `squash`, `sha` the head read); otherwise it merges nothing. |
| The outcome | `merge.merged`, the merge commit's `sha`; or `merge.refused`, the `reason`: the state, or what GitHub answered. Then a message of Agora's to the agent (`delegation.md`, "What Agora writes"): `From Agora, not the person:`, then `Pull request <owner/name>#<number> merged (squash): <sha>.` or `Pull request <owner/name>#<number> not merged: <reason>.` |
| A restart | An Answer with no outcome is carried out as the server starts: a pull request already merged is `merge.merged`. |

## Acceptance cases

| ID | Case | Expected |
| --- | --- | --- |
| G1 | `tools/list` with `github:A:write`; with `github:A:read` alone | `propose_merge` listed; then not listed, a call `not_allowed`. |
| G2 | `propose_merge` on A's open pull request; on B's, the caller holding no write on B; on a number GitHub does not know; on a closed one; a second while the card waits | `proposed …`, the card pending with the pull request's title, URL, `repo`, `number`; `not_allowed`; `not_found`; `not_open`; `question_pending`. |
| G3 | The card's state, GitHub answering each `mergeable_state` of the table | The table's state; Merge open for `ready` alone. |
| G4 | Merge on a `ready` pull request | One squash merge of the head read, as the operator; `merge.merged` with its sha; the agent's message. |
| G5 | Merge, the pull request no longer `ready` — a push dismissed the review —; GitHub refusing the merge | Nothing merged; `merge.refused` with the state, then with GitHub's message; the agent's message. |
| G6 | A Write of the person's while the card waits, during a turn and with none | `question.cancelled`; the Write accepted and delivered as any; the card cancelled. |
| G7 | The server restarted between the Answer and its outcome, the pull request merged meanwhile, then not | `merge.merged` once; then the merge carried out. |
| G8 | In a browser: the card pending, its state `review`, then `ready`; Merge; then a card cancelled by a message | The title as a link, the state, Merge closed then open; Merging…, then Merged with the sha; then Cancelled. |
| G9 | Live: an execution with `github:A:write` opens a pull request, one with `github:A:review` approves it, the first proposes its merge; the person clicks Merge | The card `ready` once approved; the pull request squash-merged by the operator; the agent told. |

# Agora — rewrite

Agora runs agents in sandboxes, keeps their exchanges and finds the work again after an
interruption. `design/agora-foundations` is the base branch of the rewrite: it starts from
scratch, with no history shared with `main`, and nothing from earlier versions is carried over
unless it is written in `docs/`.

| Folder | Content |
| --- | --- |
| `docs/` | Architecture (how it works), specs (what to implement) and ADRs (why). |
| `apps/` | What gets deployed: the server, with the client. |
| `harnesses/` | The harness images Agent Sandbox starts in its pools. |
| `packages/` | Shared code: executions, credentials, the bridge, the mock agent, test tools. |
| `.github/workflows/` | CI: checks and image publishing. |

A deployable never depends on another; a package never depends on a deployable.

## Working with branches

| Rule | Detail |
| --- | --- |
| One base | `design/agora-foundations`. Never commit to it directly: everything enters through a PR. |
| One branch per subject | Branched from the base, prefixed `feat/`, `fix/`, `chore/` or `docs/` (example: `feat/executions`). |
| Docs and code together | A subject's docs (its contract in `docs/specs/`) change in the same branch as its code, never separately. |
| Stay current | Merge the base into your branch; never merge one subject branch into another. |
| Back to the base | Through a PR with green CI; the branch is deleted after the merge. |

So two branches never edit the same doc in parallel, and every return to the base merges
without conflict.

**The day the rewrite replaces `main`**, we do not merge: we substitute. From a branch off
the base:

```sh
git merge -s ours --allow-unrelated-histories origin/main
```

This commit keeps the rewrite's tree exactly and gives it `main` as a parent: the PR to `main`
goes through without conflict, the old code leaves the tree and its history stays reachable.
It is a decision to take at that moment: the engine in production is built from `main`.

## Check and build

Node 24 runs TypeScript directly: nothing is compiled.

```sh
npm ci
npm run check      # typecheck, then each workspace's tests
```

CI checks every push and every PR to the base, then publishes the images by digest;
infra-k8s pins them (`apps/agora-sandboxes`, `apps/agora`).

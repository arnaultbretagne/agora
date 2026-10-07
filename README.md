# Agora — rewrite

Agora runs agents in sandboxes, keeps their exchanges and finds the work again after an
interruption. `design/agora-foundations` is the base branch of the rewrite: it starts from
scratch, with no history shared with `main`, and nothing from earlier versions is carried over
unless it is written in `docs/`.

| Folder | Content |
| --- | --- |
| `docs/` | Architecture (how it works), specs (what to implement) and ADRs (why). |
| `apps/` | What gets deployed: the server, with the client; the workflows, run by Prefect. |
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
infra-k8s pins them (`apps/agora-sandboxes`, `apps/agora`). Nothing is done twice:

| What | When it is skipped |
| --- | --- |
| The check, after a merge to the base | The merged tree is exactly its pull request's head, and a push run of CI passed on that head. Otherwise the merge is checked like any push. |
| An image | Its inputs already have one: each image is tagged `inputs-<fingerprint>` (`scripts/inputs.ts`), and that tag's digest is taken as is. An image is rebuilt only when its Dockerfile or what it copies changes; to take a newer base image, change its Dockerfile. |

The log's tests run four files at once, each test on a database of its own;
`LOG_TEST_CONCURRENCY=1` runs them one by one.

## Images in the cluster

After a push to the base, CI proposes the images it published to infra-k8s, in one pull request kept
up to date (branch `agora/images`). The operator merges it, and Flux deploys.

| Step | Detail |
| --- | --- |
| Which images | Those whose inputs changed since the image deployed. An image's inputs are what its Dockerfile copies, and the Dockerfile itself, fingerprinted by their git object ids (`scripts/inputs.ts`). Builds are not reproducible, so a digest alone would change on every build. |
| The server | Its digest goes into `apps/agora/kustomization.yaml` (`images`), and its source and inputs into `apps/agora/server-image.yaml`. |
| A harness | Its folder of the catalogue, `apps/agora-sandboxes/catalogue/<harness>/harness.yaml`, gets its name, image, versions, source and inputs. The name holds the digest: a new image is a new template and pool, and the warm sandboxes come up in it. A new harness gets its folder by hand. |
| A branch | Run CI by hand (workflow_dispatch) on it: its own pull request, `agora/images-<branch>`, for a preview. |
| The token | `INFRA_K8S_TOKEN`, a fine-grained token on infra-k8s alone: contents and pull requests, read and write. Without it, CI only notes that nothing was proposed. |

`scripts/propose-infra.ts` does the writing. It runs anywhere with an infra-k8s checkout:
`node scripts/propose-infra.ts --infra <checkout> --digests <dir> --ref <branch> --sha <commit>`.

# flows

Agora's workflows on Prefect: a lead decides, the flow carries out, and each member of the team
works in its own Workstream, through the server's API (`docs/specs/flows.md`). Prefect's worker runs
them in-cluster (infra-k8s `apps/prefect`); nothing here is built into an image.

| File | Content |
| --- | --- |
| `roles/` | The role cards — `lead`, `dev`, `sre`, `judge`: each one's persona and default harness, model and effort. |
| `team.py` | The team, standard library only: the cards, Agora's offer, the lead's decisions and what the flow accepts of them, every prompt. |
| `agora.py` | A member's turns on Agora, standard library only: ids derived from the turn, its execution, the Write, the answer. |
| `flows.py` | The flows: `lead`, `lead-rehearsal` and `rehearsal`. |
| `deploy.py` | Registers a branch's flows on the work pool `agora`. |
| `test_agora.py`, `test_team.py` | Unit cases, against a stand-in Agora. |

## Check

```sh
npm test -w @agora/flows
```

## Deploy a branch

`deploy.py` registers the branch's flows, named after it (`/` written `-`), from the worker's Pod,
which has git and Prefect's API:

```sh
kubectl -n prefect cp apps/flows/deploy.py <worker-pod>:/tmp/deploy.py
kubectl -n prefect exec <worker-pod> -- python /tmp/deploy.py <branch>
```

Each run clones the branch again: pushing to it changes the next run, and a resumed one, without
redeploying.

## Run

In Prefect's UI (prefect.bretagne.dev), or from the worker's Pod:

```sh
# The lead's mechanics on the mock, its answers scripted; its Workstreams belong to the live cases' owner.
prefect deployment run lead-rehearsal/<branch>
# For real: the goal is the lead's only brief.
prefect deployment run lead/<branch> --param goal="…"
# A role's settings for one run.
prefect deployment run lead/<branch> --param goal="…" --param 'overrides={"dev": {"model": "sonnet"}}'
```

A run that waits for you asks in Agora: the lead's Workstream, `[flow <run>] lead: …`, shows
"waiting for you" in the list, and its card takes your answer — the envelope first, then whatever the
lead asks. In Prefect, the run stays `Running`, its task `Waiting for you: …` on the graph.

A run whose worker Pod died stays `Running`: mark it `Crashed` (Prefect's API, `set_flow_run_state`
with `force`), then `prefect flow-run retry <id>`; its turns find their Workstreams again.

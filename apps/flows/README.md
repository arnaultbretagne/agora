# flows

Agora's workflows on Prefect: each step runs one agent in its own Workstream, through the
server's API (`docs/specs/flows.md`). Prefect's worker runs them in-cluster (infra-k8s
`apps/prefect`); nothing here is built into an image.

| File | Content |
| --- | --- |
| `agora.py` | A step on Agora, standard library only: ids derived from the step, Create, Write, the turn, Stop. |
| `flows.py` | The flows: `rehearsal` and `archi-dev-review`. |
| `deploy.py` | Registers a branch's flows on the work pool `agora`. |
| `test_agora.py` | Unit cases F1–F5, F9–F11, against a stand-in Agora and a clock advanced by its sleep. |

## Check

```sh
npm test -w @agora/flows
```

## Deploy a branch

`deploy.py` registers both flows of a branch, named after it (`/` written `-`), from the worker's
Pod, which has git and Prefect's API:

```sh
kubectl -n prefect cp apps/flows/deploy.py <worker-pod>:/tmp/deploy.py
kubectl -n prefect exec <worker-pod> -- python /tmp/deploy.py feat/flows
```

Each run clones the branch again: pushing to it changes the next run, without redeploying.

## Run

In Prefect's UI (prefect.bretagne.dev), or from the worker's Pod:

```sh
# The mock, one step and a replay; its Workstreams belong to the live cases' owner.
prefect deployment run rehearsal/feat-flows --param prompt="/sleep 20" --watch
# The whole workflow on the mock, the review asking for changes once.
prefect deployment run archi-dev-review/feat-flows --param goal="…" \
  --param architect=mock --param developer=mock --param reviewer=mock \
  --param 'rehearsal_verdicts=["changes","approve"]' --param owner=c45e0000-0000-4000-8000-000000000000
# For real.
prefect deployment run archi-dev-review/feat-flows --param goal="…"
```

A run that waits for a human shows `Suspended`: resume it from its page in the UI, with the form.

A run whose worker Pod died stays `Running`: mark it `Crashed` (Prefect's API, `set_flow_run_state`
with `force`), then `prefect flow-run retry <id>`; its steps find their Workstreams again.

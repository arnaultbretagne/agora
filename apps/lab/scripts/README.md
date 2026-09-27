# scripts

`live-cases.ts` joue les 22 cas de [docs/executions.md](../../../docs/executions.md) contre le
banc déployé, avec de vrais sandboxes Kata détruits par Agent Sandbox. Depuis g4, l'IP du Pod
du banc est joignable :

```sh
node apps/lab/scripts/live-cases.ts http://<ip du banc>:8080 [numéros de cas]
```

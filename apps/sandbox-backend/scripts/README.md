# scripts

`live-cases.ts` joue les 22 cas du contrat contre un back-end déployé, avec de vrais sandboxes
Kata détruits par Agent Sandbox. Depuis g4, l'IP du Pod du back-end est joignable :

```sh
node apps/sandbox-backend/scripts/live-cases.ts http://<ip du back-end>:8080 [numéros de cas]
```

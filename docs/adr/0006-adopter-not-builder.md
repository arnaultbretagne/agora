# ADR 0006 — Adopter, pas builder : le paysage et la décision

## Status

Proposed — 2026-06-30

## Context

On construit un produit (hub + channel) au-dessus de Claude Code. Question d'hygiène : **est-ce qu'on
réinvente un truc qui existe ?** Beaucoup d'outils gravitent autour des agents CLI — avant de bâtir, on
**scoute**. Risque inverse : adopter un framework lourd qui nous **enferme** (et nous ramène vers
l'API/SDK = Damoclès, `agent-runtime` ADR 0005).

## Decision

**Adopter la *primitive* (channels), construire *thin* le produit (hub + channel) — ne pas adopter de
framework d'agent.**

- On **adopte** ce qui est **natif et abonnement-safe** : la primitive `channels`, le format JSONL, le
  mécanisme plugin (ADR 0002 / 0005).
- On **construit nous-mêmes, mince**, le hub et le channel — parce que c'est **notre** topologie
  `(site → runtimes → pipes)` et **nos** contraintes (abonnement, single-user, k8s, OIDC), qu'aucun
  outil ne sert *telles quelles*.
- On **n'adopte pas** de framework d'orchestration d'agents (qui présument l'API/SDK ou un autre modèle
  d'exécution).
- **fakechat** = la **référence** (preuve qu'un channel + web UI tient), **pas** une dépendance.

## Rationale — le paysage scouté

Chacun est utile ; aucun ne **remplace** le produit sous nos contraintes :

- **fakechat** (Anthropic, `external_plugins/`) — channel + web UI dans **un** process (couple
  channel + site, `127.0.0.1`). **Parfait comme preuve et amorce MVP** ; pas un produit
  multi-conversation / multi-client / k8s. ⇒ on s'en **inspire**, on **dé-couple** (ADR 0001 / 0003).
- **Happy** (happy.engineering) — mobile/desktop pour Claude Code, chiffré e2e, multi-session. Très
  proche de l'intention « piloter Claude à distance » — mais **service tiers**, sa propre
  infra / compte ; nous on veut **notre** plateforme k8s, single-user, derrière **notre** OIDC.
  ⇒ confirme le besoin, ne le **sert** pas chez nous.
- **agentapi** (Coder) — **HTTP au-dessus du TUI** par **parsing du terminal**. C'est l'approche
  « scrape le PTY » qu'on **évite** : fragile — et surtout `channels` la rend **inutile** (push natif >
  scraping). ⇒ écarté **par** la primitive.
- **OpenCode / Pi** — autres harnais CLI. Intéressants, mais **pas l'abonnement Claude** (le point dur,
  `agent-runtime` ADR 0005). Hors-cible tant que la contrainte est « rester sur le forfait Claude ».
  *(Veille : si un jour multi-harnais, ils rentrent comme `kinds` derrière le superviseur.)*
- **Codex App-Server / CloudCLI** — l'angle « serveur d'app » d'autres écosystèmes. Même verdict : pas
  l'abonnement Claude, pas notre topologie. Utile comme **veille** sur le pattern (un app-server devant
  un agent), pas comme socle.

**Pourquoi « build-thin-own » :**

- **Aucun outil ne cumule nos contraintes** : (abonnement Claude OAuth) × (single-user, Terms) ×
  (k8s + OIDC maison) × (multi-conversation `(conv, pipe)`). Chacun lâche **au moins une**.
- **La primitive fait le gros œuvre.** Avec `channels` + JSONL, le produit qui reste est **mince** : un
  routeur/agrégateur + un pont stdio↔WS. Le construire nous-mêmes coûte **moins** que plier un framework
  tiers à nos contraintes — et **n'ajoute aucune** dépendance qui pourrait nous ramener vers l'API/SDK.
- **Adopter la primitive, pas le framework** = hériter du travail d'Anthropic *là où il est sûr* (le
  push natif), sans hériter d'un modèle d'exécution qui **trahit** la contrainte abonnement.

## Consequences

- **Dette de veille assumée** : `channels` (preview) et le format JSONL bougent → on suit Claude Code
  de près (et c'est *déjà* le cycle de vie de l'image `agent-runtime`). Happy / OpenCode / Codex =
  veille passive.
- **fakechat reste le banc d'essai** : tout doute sur la primitive se tranche en **regardant / forkant
  fakechat** avant de spéculer.
- **Invariant** : pas de framework d'agent dans les dépendances d'agora. Une PR qui en introduit un doit
  d'abord **tuer la contrainte abonnement** (donc : refusée par défaut).
- Si la contrainte « abonnement Claude » **tombait** un jour (improbable), la décision *adopter-vs-
  builder* serait à **rouvrir** (OpenCode / multi-harnais deviendraient pertinents). Noté pour ne pas
  l'oublier.

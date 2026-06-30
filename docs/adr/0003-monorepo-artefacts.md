# ADR 0003 — Monorepo + multi-artefacts

## Status

Proposed — 2026-06-30

## Context

`agora` porte trois choses (ADR 0001) : le **site**, le **channel**, et le **protocole** qui les
relie. Elles ont des **lieux d'exécution** et des **formats de livraison** différents : le site = une
**image** dans son pod ; le channel = un **plugin** spawné dans le pod runtime ; le protocole = du
code **partagé** par les deux.

Un repo par artefact, ou un monorepo ?

## Decision

**Un monorepo `agora`, trois artefacts :**

| Dossier | Build → | Lieu d'exécution |
|---|---|---|
| `website/` | **image** | son propre pod |
| `channel/` | **plugin Claude Code** | sur le PVC du runtime, spawné par claude |
| `shared/` | *(dépendance interne)* | compilé dans les deux |

- `shared/` = **le protocole WS** (types / messages), **consommé par website et channel**.
- **claude ne récupère que `channel/`** (le plugin) ; il ne voit **jamais** `website/`.

## Rationale

- **Le protocole est l'arête commune → un monorepo le garde cohérent.** Le channel et le site se
  parlent en WS (ADR 0002). Leur contrat (`shared/`) doit évoluer **d'un seul tenant** : un changement
  de message touche **les deux bouts dans le même commit**, le même PR, le même CI. Deux repos =
  versionner un protocole **entre soi et soi** = douleur gratuite.
- **Mais des artefacts séparés, parce que les lieux d'exécution diffèrent.** Le channel **n'est pas**
  dans l'image du site, et inversement. **Co-localisé-au-runtime ≠ baké-dans-l'image-runtime** : le
  plugin vit sur le **PVC**, livré/installé à part (exactement comme fakechat = plugin Anthropic sur le
  PVC). Le monorepo **n'efface pas** la frontière de déploiement ; il l'**outille** (un build par
  cible).
- **claude ne tire que le channel.** Le runtime n'a **aucune raison** de connaître le site : il spawn
  un plugin (le channel) qui, lui, sait parler au site. ⇒ surface minimale côté runtime, et le site
  reste **remplaçable** sans toucher au runtime.
- **Pourquoi pas trois repos.** Le coût (versionner `shared/` à la main, 3 CI, 3 PR pour un seul
  changement de protocole) **dépasse** le bénéfice — une indépendance dont on n'a pas besoin : les
  trois bougent **ensemble**. Si un artefact prend un jour une vraie vie propre (release propre), on
  l'**essaime** — pas avant.

## Consequences

- Layout : `agora/{website,channel,shared}/` + `docs/adr/`. `shared/` est une **dépendance interne**,
  pas un package publié.
- **Deux pipelines de build** depuis un repo : `website/` → image (registry) ; `channel/` → plugin
  (artefact installable sur le PVC). `shared/` n'a **pas** de build propre — il est compilé dans
  chacun.
- **Versionnement du protocole = interne au repo** : channel et website **d'un même commit** sont
  garantis compatibles. Le cas « channel d'une version / site d'une autre » existe **à l'exécution**
  (runtime long-vivant vs site redéployé) → c'est un sujet de **compat du protocole**, traité en
  écrivant `shared/`, **pas** un sujet de repo.
- Le **plugin** suit le format plugin Claude Code (manifest, `mcpServers`, …) — détail calé en le
  construisant.
- **L'installation du plugin sur le PVC** est un geste de déploiement (qui le pose, quand) à câbler
  côté `infra-k8s`. Ici on acte juste : **livré comme plugin, pas baké dans l'image**.

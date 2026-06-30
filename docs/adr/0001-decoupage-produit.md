# ADR 0001 — Découpage produit : un site qui pilote des runtimes via des channels

## Status

Proposed — 2026-06-30

## Context

La brique infra existe (`agent-runtime`) : un **superviseur thin** qui spawn des **process
opaques** dans un pod, plus l'image qui les porte. Elle est **agnostique au produit** — elle ne
sait rien de « conversations », de « channels » ni de « claude » (ADR 0001-0002 d'`agent-runtime`).

Il faut maintenant **le produit** : ce avec quoi l'humain interagit, et ce qui donne un sens à ces
process. Avant d'écrire une ligne, on fixe **l'image** — parce que c'est là qu'on a failli
sur-architecturer. On avait laissé filer un vocabulaire de « socle » et de « 3 couches » : ça
sonnait sérieux mais ça **masquait** la réalité au lieu de la décrire.

## Decision

Le produit, c'est **un site qui pilote des runtimes distants via des pipes (channels)**.
**Trois rôles, pas un de plus :**

1. **Le site (`website`)** — le **hub**. Là où l'humain parle à ses agents. Il agrège N
   conversations, pilote l'**API du superviseur** (spawn/kill/list), et **route** les messages vers
   le bon pipe.
2. **Les runtimes** — des process `claude` distants, dans le pod `agent-runtime`. **Un runtime =
   une conversation.** Opaques au site, **sauf** au travers de leur pipe.
3. **Les channels (pipes)** — le tuyau entre un runtime et le site. C'est la primitive `channels`
   **native** de Claude Code : un serveur MCP **stdio** que `claude` **spawn lui-même**, qui relaie
   ensuite en **WS** vers le site.

```
   l'humain
      │
      ▼
  ┌────────┐   API superviseur    ┌──────────────┐
  │  site  │◄────(lifecycle)─────►│ agent-runtime│
  │ (hub)  │                      │  superviseur │
  │        │                      │   ├─ runtime#1 ─spawn→ channel#1 ─┐
  │        │◄───── WS (messages) ──┼───┘                              │
  │        │◄───── WS (messages) ──┼──── runtime#N ─spawn→ channel#N ─┘
  └────────┘                      └──────────────┘
```

C'est tout. **Pas de couche au-dessus**, pas de « moteur », pas de « socle ». Une **topologie**
(un hub, des runtimes, des pipes), pas une **pile**.

## Rationale

- **L'image tient en une phrase.** « Un site qui pilote des runtimes via des pipes. » Si décrire le
  produit demande plus de mots que ça, c'est qu'on a inventé une abstraction de trop. La règle de
  ce repo : si un concept n'est pas dans cette phrase, il doit **gagner** sa place.
- **Le découpage suit la frontière de déploiement réelle**, pas une taxonomie : le site tourne dans
  *son* pod ; le runtime dans le sien ; le channel est co-localisé au runtime (contrainte `stdio` de
  la primitive) mais reste du **code produit**. Trois rôles = **trois réalités**, pas trois étages
  décrétés.
- **Le site ne connaît les runtimes que par le pipe.** Il parle au **superviseur** (cycle de vie) et
  aux **channels** (messages) — jamais au binaire. Il ne « sait » même pas que `claude` existe : il
  voit des **conversations derrière des pipes**. ⇒ demain un runtime `codex` se branche à
  l'identique (il apporte *son* pipe, cf. `agent-runtime` ADR 0002).
- **Pourquoi pas « socle / 3 couches ».** Ça suggérait une **stratification** — un truc fondateur,
  des étages empilés — qui n'existe pas. Il n'y a pas de bas ni de haut : il y a un hub, des
  runtimes, et des pipes entre eux. Nommer une topologie « pile » fait chercher une hiérarchie
  qu'on perdrait du temps à maintenir.

## Consequences

- Le repo `agora` porte **le site + le channel + le protocole**, et **rien** de l'infra
  (image / superviseur / auth / sécurité du pod = `agent-runtime`).
- La **surface produit ↔ infra** se réduit à **deux contrats**, et c'est volontaire :
  1. l'**API du superviseur** (`agent-runtime`) — créer / tuer / lister des runtimes ;
  2. les **channels** (WS) — convoyer les messages.
  Tout le reste du produit vit **au-dessus** de ces deux contrats, sans les percer.
- Le channel étant co-localisé au runtime **mais produit**, il est livré comme **plugin** (installé
  sur le PVC, hors image) — détaillé en **ADR 0003** (monorepo / artefacts).
- Les ADR suivants déplient chaque rôle : la **primitive channel** (0002), le **découpage
  monorepo** (0003), le **site = hub** (0004), le **découplage conversation / history** (0005), et
  le positionnement **adopter-vs-builder** (0006).

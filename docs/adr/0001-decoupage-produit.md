# ADR 0001 — Découpage produit : un site qui pilote des runtimes via des channels

## Status

Proposed — 2026-06-30

## Context

La brique infra existe (`agent-runtime`) : un **superviseur thin** qui spawn des **process
opaques** dans un pod, plus l'image qui les porte. Elle est **agnostique au produit** — elle ne
sait rien de « conversations », de « channels » ni de « claude » (ADR 0001-0002 d'`agent-runtime`).

Il faut maintenant **le produit** : ce avec quoi l'humain interagit, et ce qui donne un sens à ces
process. Avant d'écrire une ligne, on fixe **l'image** — parce qu'il y a deux pièges :

1. **Sur-architecturer.** On avait laissé filer un vocabulaire de « socle » et de « 3 couches » :
   ça sonnait sérieux mais ça **masquait** la réalité au lieu de la décrire.
2. **Faire du hub un gestionnaire de runtimes.** Tentant de dire « le site pilote les runtimes ».
   Mais le site ne **porte** pas de runtimes : il manipule des **conversations** et leur **pipe**.
   Le « runtime » est le mot du **superviseur**, pas du site.

## Decision

Le produit, c'est **un site qui pilote des runtimes distants via des pipes (channels)** — ça,
c'est la vérité *physique* de la plateforme. Mais **du point de vue du site, il n'y a pas de
« runtimes »** : le hub voit des **conversations** et leur **pipe**.

> **1 conversation ⟷ 1 channel (pipe) ⟷ 1 runtime.** Même cardinalité, **trois noms — selon qui
> regarde.** Le hub regarde par `(conversation, pipe)` ; le superviseur regarde par `runtime`.

Trois rôles, et surtout la **projection** de chacun :

1. **Le site (`website`) — le hub.** Sa vue, c'est **`(conversation, pipe)`**. Il agrège N
   conversations et **route** les messages vers le pipe de chacune. Il **ne porte pas** de
   runtimes : pour *démarrer / arrêter* une conversation il **actionne le superviseur** (lifecycle) ;
   à la **création** il choisit *quel agent* (claude, demain codex) — **seul** moment où un « type »
   affleure, et c'est un **attribut de la conversation**, pas de la gestion de process. Tout le
   reste du temps : conversation ⟷ pipe.
2. **Les runtimes — opaques, possédés par le superviseur.** Des process `claude` derrière les
   pipes, dans `agent-runtime`. **Invisibles au hub** sauf comme « ce qui est au bout du pipe » :
   leurs PID, leur binaire, leur cycle de vie = l'affaire du superviseur (`agent-runtime`
   ADR 0001-0002), pas du site.
3. **Les channels (pipes).** Le tuyau entre une conversation et le site. C'est la primitive
   `channels` **native** de Claude Code : un serveur MCP **stdio** que `claude` **spawn lui-même**,
   qui relaie en **WS** vers le hub.

```
     l'humain
        │
        ▼
  ┌─ site (hub) ───────────┐                        ┌─ agent-runtime ────────────┐
  │  conv A ── pipe A  ◄════╪═══════ WS ═════════════╪══ runtime A (claude)        │
  │  conv B ── pipe B  ◄════╪═══════ WS ═════════════╪══ runtime B (claude)        │
  │        │                │                        │        ▲ spawn/kill         │
  │        ╰── lifecycle ───╪──── API superviseur ───╪──► superviseur ─────────────┘
  └─────────────────────────┘                        └────────────────────────────┘
     vue du hub : (conversation ↔ pipe)         runtime = opaque, possédé par le superviseur
```

Deux plans : un **plan données** (les pipes, en WS, qui relient une conversation à son runtime) et
un **plan contrôle** (le hub → l'API superviseur, pour ouvrir/fermer). **Pas de couche au-dessus**,
pas de « moteur », pas de « socle ». Une **topologie**, pas une **pile**.

## Rationale

- **L'image tient en une phrase** — au niveau plateforme : *« un site qui pilote des runtimes via
  des pipes »*. Mais **le hub, lui, ne manipule que `(conversation, pipe)`** ; le « runtime » est le
  mot du superviseur. Règle du repo : côté hub, si un concept n'est ni une conversation ni un pipe,
  il doit **gagner** sa place.
- **Pourquoi la projection `(conversation, pipe)` et pas `(runtime)`.** Le runtime est un **process
  opaque possédé par le superviseur** (`agent-runtime` ADR 0002). Le hub ne gagne **rien** à suivre
  des PID ou des binaires ; il gagne **tout** à suivre des **conversations** (la chose que l'humain
  voit) et leur **pipe vivant**. Bonus : ça garde le hub **runtime-agnostic** — codex, c'est la même
  `(conversation, pipe)`, juste un autre *kind* choisi à la création.
- **Un seul fil de contrôle hub → superviseur, et c'est tout le lifecycle.** Il faut bien *quelqu'un*
  pour déclencher le spawn, et le clic « nouvelle conversation » naît dans le site → le hub actionne
  le superviseur. Mais il **délègue** : il dit « ouvre / ferme une conversation (de tel kind) », il
  ne **gère** pas le process.
- **Le découpage suit la frontière de déploiement réelle**, pas une taxonomie : le site dans *son*
  pod ; le runtime dans le sien ; le channel co-localisé au runtime (contrainte `stdio`) mais code
  **produit**. Trois rôles = **trois réalités**, pas trois étages décrétés.
- **Pourquoi pas « socle / 3 couches ».** Ça suggérait une **stratification** — un fondateur, des
  étages — qui n'existe pas. Il n'y a pas de bas ni de haut : un hub, des conversations, leurs
  pipes, et un superviseur qu'on actionne. Nommer ça « pile » fait chercher une hiérarchie qu'on
  perdrait du temps à maintenir.

## Consequences

- Le repo `agora` porte **le site + le channel + le protocole**, et **rien** de l'infra
  (image / superviseur / auth / sécurité du pod = `agent-runtime`).
- **Le hub ne tient pas de « registre de runtimes » : il tient un registre de conversations**,
  chacune avec son pipe (et, *incidemment*, un process backing que le superviseur possède).
  « Lister ce qui tourne » = lister des **conversations à pipe vivant**, pas des runtimes.
- La **surface produit ↔ infra** se réduit à **deux contrats**, et c'est volontaire :
  1. l'**API du superviseur** (`agent-runtime`) — *ouvrir / fermer* une conversation (et choisir son
     *kind* à la création) ;
  2. les **channels** (WS) — convoyer les messages.
  Tout le reste du produit vit **au-dessus** de ces deux contrats, sans les percer.
- Le **seul** endroit où le « type » de runtime affleure côté produit = **le choix de l'agent à la
  création** d'une conversation (claude / codex), porté comme **attribut de conversation** — jamais
  comme de la gestion de process.
- Le channel étant co-localisé au runtime **mais produit**, il est livré comme **plugin** (installé
  sur le PVC, hors image) — détaillé en **ADR 0003** (monorepo / artefacts).
- Les ADR suivants déplient chaque rôle : la **primitive channel** (0002), le **découpage
  monorepo** (0003), le **site = hub** (0004), le **découplage conversation / history** (0005), et
  le positionnement **adopter-vs-builder** (0006).

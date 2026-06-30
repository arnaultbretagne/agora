# ADR 0005 — Conversation 1ʳᵉ classe : history produit (hub, neutre) vs resume runtime (natif)

## Status

Proposed — 2026-06-30. **Mécanisme à valider par un spike** (cf. § *À valider*). On fixe le
**principe** ; on ne grave **pas** les détails d'un amont qu'on n'a pas encore éprouvé.

## Context

Le hub agrège des **conversations** (ADR 0004) ; une conversation **survit** à son pipe (UX
« claude.ai » : rouvrir, lire le passé, reprendre — **même quand aucun runtime ne tourne**). La
**conversation** est l'objet de 1ʳᵉ classe, pas le fichier (≠ l'angle « vault + git » des vieux
outils).

**Première intention — écartée.** « history = un read-model des JSONL `~/.claude/projects` ». Deux
défauts **rédhibitoires** :

1. **Otage du PVC** — pas de connexion au PVC du runtime ⇒ **plus d'history du tout**.
2. **Otage du format** — le JSONL est **spécifique Claude Code** ⇒ casse le **runtime-agnostic**
   (codex n'écrit pas ce format ; ADR 0001/0002).

Elle **confondait deux choses différentes** : la *conversation* (ce que l'humain lit) et le *contexte
de reprise* de l'agent. Et surtout : **on ne sait pas encore précisément comment l'amont se
comporte** (ce que le channel charrie, comment `--resume` réagit, le buffering aux coupures…). Donc
on pose une **direction**, pas un mécanisme figé.

## Decision

**La conversation est de 1ʳᵉ classe. On sépare deux préoccupations — par propriétaire et par
format :**

1. **History (produit) — possédée par le hub, en format neutre.** La conversation (tours
   user↔agent) est **persistée par le hub au fil de l'eau, à partir de ce qu'il observe sur le
   pipe** (protocole `shared/`, ADR 0003). **Neutre** (donc multi-harnais), **chez le hub** (donc
   indépendante du PVC). C'est ce que **tout client affiche**.
2. **Resume (runtime) — possédé par le superviseur/runtime, en format natif.** Reprendre l'agent =
   son **mécanisme natif** (`--resume` sur le JSONL pour claude), **derrière la frontière runtime**.
   **Harness-spécifique par nature**, et c'est OK : ça ne **traverse jamais** vers le produit.

États de conversation : **`live`** (pipe ⟷ runtime) / **`dormante`** (history du hub, pas de runtime).

> **Principe directeur — ce qu'on tient pour ferme :** *l'history produit ne doit dépendre ni du
> format d'un harnais, ni de la disponibilité d'un PVC de runtime.* Le **comment** ci-dessus est
> l'**hypothèse de travail**, à éprouver (§ *À valider*) — pas un dogme.

## Rationale

- **Le hub voit déjà la conversation passer.** C'est la définition même du channel (`reply()` =
  comment l'agent parle à l'humain ; le message user transite par le hub aussi). Il la **persiste au
  fil de l'eau** — il n'a **jamais eu besoin** du JSONL pour l'history.
- **Deux données, pas une copie.** hub-history (conversation neutre) ≠ JSONL (contexte de travail
  natif). Comme ce ne sont **pas** des copies, **pas de divergence** — et ça **corrige** le faux
  principe « derive / don't duplicate » de la 1ʳᵉ intention (qui prétendait éviter une duplication
  qui n'existe pas).
- **Neutre ⇒ multi-harnais ; hub-owned ⇒ disponible.** Les deux défauts de la 1ʳᵉ intention tombent.
  Bonus résilience : PVC/JSONL perdu ⇒ on **garde la conversation**, et on peut **re-seed** un
  runtime frais avec (à éprouver, voir plus bas).
- **Resume natif plutôt que « garder le runtime vivant ».** Garder N runtimes vivants « au cas où » =
  coûteux (RAM, creds — `agent-runtime` ADR 0006) ; le mécanisme natif de reprise suffit. Les
  conversations restent **bon marché** et **disposables** : *pas de pipe ≠ pas de conversation*.

## À valider (spike) — avant de graver le mécanisme

On **teste sur l'amont réel** (fakechat + claude) ces inconnues, et on **ajuste** la Decision si
besoin :

- **Ce que le channel charrie vraiment** — `reply()` donne-t-il des **tours nets** ? du
  streaming / des partiels ? les **tool-use / thinking**, ou juste le texte final ? → détermine si
  « le hub observe » suffit à une history **fidèle**.
- **Complétude** — le hub voit-il **100 %** des tours user-facing, ou claude peut-il émettre
  hors-channel ?
- **`--resume` en vrai** — a-t-il besoin du **JSONL exact / au même chemin** ? un **pod frais**
  peut-il reprendre une session dont le JSONL est sur le PVC ? rejoue-t-il proprement ?
- **Hub down** — le channel **bufferise**-t-il les `reply()` et **redélivre au reconnect**, ou ça
  tombe ? → complétude de l'history aux coupures.
- **Re-seed** — nourrir un runtime frais avec l'history **neutre** (la résilience « PVC perdu ») :
  viable / acceptable ?

## Consequences

- **Deux états** (`live` / `dormante`) présentés d'un même geste (la liste claude.ai).
- **Le hub possède un store de conversations** (history neutre) → **patche ADR 0004** : l'état du
  hub n'est plus « mince ».
- **Mapping d'identité** à tenir : conversation produit ⟷ **session native de resume** (id
  `--resume`) ⟷ `chat_id` du pipe quand elle est `live`.
- **Le natif (JSONL) reste derrière la frontière runtime** : isolé, **jamais exposé** au produit.
  Un changement de format Claude n'impacte que le **resume**, pas l'**history**.
- **Hors-scope** : éditer / forker une conversation ; **importer** une session claude créée hors
  agora (parseur JSONL ponctuel, harness-spécifique).
- **Statut provisoire assumé** : la Decision tient le **principe** ; le **mécanisme** se confirme /
  s'ajuste après le spike — même posture que « adopter une preview » (ADR 0002 / 0006).

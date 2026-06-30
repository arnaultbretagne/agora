# ADR 0005 — Découplage conversation / history

## Status

Proposed — 2026-06-30

## Context

Le hub agrège des **conversations** (ADR 0004) ; sa vue runtime = `(conversation, pipe)`. Mais une
conversation **survit** à son pipe : claude tient un **historique** sur disque, et on veut une UX
« claude.ai » (rouvrir, reprendre, lire le passé) — **y compris quand aucun runtime ne tourne**.

Tentation héritée des vieux outils : modéliser ça comme un **vault de fichiers + git** (l'angle
« notes »). Mauvais axe — la **conversation** est l'objet de première classe, pas le fichier.

Fait technique : Claude Code **persiste déjà** chaque session en **JSONL** sous
`~/.claude/projects/…` (sur le PVC), et sait **reprendre** une session (`--resume`).

## Decision

**Découpler la conversation (axe de 1ʳᵉ classe) de son history (un read-model dérivé des JSONL).**

- **La conversation est l'entité produit.** Identité **stable**, indépendante du fait qu'un runtime
  tourne *là, maintenant*. État : **`live`** (pipe branché) ou **`dormante`** (pas de runtime, mais un
  history).
- **L'history est un read-model**, **dérivé** des **JSONL de `~/.claude/projects`** (sur le PVC) :
  **source de vérité = le harnais**, pas une base qu'on tiendrait en double. Le hub **lit** ces JSONL
  pour afficher le passé d'une conversation dormante.
- **Reprendre = re-spawn + `--resume`.** Rouvrir une conversation dormante : le hub demande au
  superviseur un runtime **branché sur la session existante** (resume du bon JSONL) → un **nouveau
  pipe, même conversation**.
- **« Continue sans moi ».** L'history étant sur le PVC et la reprise explicite, l'humain peut
  **fermer** le hub : le runtime peut continuer (travail en cours) ou être tué et **repris plus tard**.
  La conversation **n'est pas** prisonnière d'une connexion vivante.

## Rationale

- **La conversation, pas le fichier, est l'axe.** Un humain pense « ma conversation avec l'agent », pas
  « le `.jsonl` ». Modéliser en *notes + git* (vault) optimise le mauvais objet (le document) et rate
  l'UX attendue (un fil qu'on reprend). claude.ai a raison : l'unité, c'est **le fil**.
- **Pourquoi un read-model dérivé (pas une 2ᵉ source).** Le harnais **possède déjà** la vérité (JSONL,
  format resume-able). Tenir une base parallèle = **divergence** garantie (le jour où claude écrit un
  tour qu'on n'a pas capté). On **dérive** → on ne peut pas désynchroniser. Le hub ne *stocke* pas
  l'history, il le **projette**.
- **Pourquoi `--resume` plutôt que « garder le runtime vivant ».** Garder N runtimes vivants « au cas
  où » = coûteux (RAM, creds — `agent-runtime` ADR 0006) et inutile : le JSONL **est** la conversation.
  Tuer / relancer-resume rend les conversations **bon marché** et **disposables** (cohérent avec la
  philosophie pod-frontière). Le `(conversation, pipe)` redevient simplement : **pas de pipe ≠ pas de
  conversation**.
- **Le découplage achète le multi-clients ET le offline.** Si l'history est un read-model du PVC,
  n'importe quel client (et le hub lui-même) peut afficher une conversation dormante **sans runtime**.
  C'est ce qui rend « ferme l'onglet, reviens demain » trivial.

## Consequences

- **Deux états de conversation** : `live` (pipe ⟷ runtime) et `dormante` (history seul). Le hub
  présente les **deux** d'un même geste (la liste claude.ai).
- **Le hub lit le PVC** (les JSONL `~/.claude/projects`) en **read-model**. *Comment* (montage partagé
  ? une API de lecture exposée par le superviseur ?) = à trancher en construisant ; l'ADR fixe le
  **principe** (dérivé, pas dupliqué), pas la plomberie.
- **Mapping d'identité** à tenir : « conversation produit » ⟷ « session JSONL / id de `--resume` » ⟷
  `chat_id` du pipe quand elle est live. C'est l'**ossature** de l'historique + reprise.
- **Format JSONL = dépendance au harnais** (comme `channels`, ADR 0002). Il bouge avec Claude Code → le
  parsing du read-model est **isolé** dans un module, pas éparpillé.
- **Limite assumée** : le read-model **affiche / reprend** ; il ne **réécrit pas** l'history (la vérité
  reste au harnais). Éditer / forker / brancher une conversation = hors scope (évolution éventuelle).
- Pose les bases de l'UX « claude.ai-like » (liste, reprise, lecture offline) que le hub (ADR 0004)
  rend.

# ADR 0004 — Website = hub

## Status

Proposed — 2026-06-30

## Context

Le site, c'est le hub (ADR 0001) ; sa vue = `(conversation, pipe)`. Il faut dire **ce qu'il fait**
concrètement — sans empiéter sur le *qu'est-ce qu'une conversation / un history* (ADR 0005). Plusieurs
entrées sont possibles (navigateur d'abord ; iOS, Discord… plus tard).

## Decision

**Le website est le hub : il agrège les conversations, actionne le superviseur, et route les messages
entre les clients et les pipes.** Quatre fonctions, pas plus :

1. **Agrégation multi-conversation.** Une vue de toutes les conversations (à pipe vivant **ou non**),
   façon claude.ai. C'est *le* point d'entrée humain.
2. **Lifecycle (plan contrôle).** Ouvrir / fermer une conversation = actionner l'**API superviseur**
   (et choisir le *kind* à la création). Le hub **ne gère pas** le process (ADR 0001).
3. **Routing (plan données).** Faire transiter les messages **client ⟷ pipe** : du client vers le bon
   channel (`chat_id`, ADR 0002), et le `reply` du channel vers le bon client. Le hub **ne génère
   pas** de contenu d'agent — il **relaie** (le contenu naît dans claude, via le channel).
4. **Multi-clients / multi-flux.** Le hub est **la façade** ; les clients (navigateur, demain
   iOS/Discord) s'y branchent. Un client n'a **jamais** de lien direct au runtime — **toujours** via
   le hub.

## Rationale

- **Le hub est un routeur + un agrégateur, pas un cerveau.** Toute l'intelligence est dans les
  runtimes (claude). Le hub **multiplexe** : N conversations, M clients, le bon message au bon pipe.
  Le garder « bête » = le garder **remplaçable** et **runtime-agnostic** (cohérent avec ADR 0001).
- **Pourquoi le hub porte le lifecycle (et pas un client).** L'API superviseur est interne (pod-à-pod,
  derrière la frontière sécu de `agent-runtime` ADR 0003). L'exposer aux clients = **percer** la
  frontière. Le hub est **le seul** point qui parle au superviseur ; les clients parlent au **hub**.
  Une seule porte.
- **Pourquoi multi-clients dès le design (même si navigateur d'abord).** Le `(conversation, pipe)` ne
  présume **rien** du client. Tant que le hub reste la façade WS, ajouter iOS/Discord = un adaptateur
  de **présentation**, pas une refonte. On ne *construit* pas tout ça maintenant — on s'interdit juste
  de le **rendre impossible**.
- **Le hub est derrière l'OIDC gate.** L'accès humain passe par oauth2-proxy (`infra-k8s` ADR 0021) →
  le hub suppose un utilisateur **déjà authentifié**, et reste **single-user** (Terms, `agent-runtime`
  ADR 0005) : pas de multi-tenant.

## Consequences

- Le website expose **deux surfaces** : vers les **clients** (WS + UI — la façade) ; vers l'**infra**
  (API superviseur + WS des channels). C'est le **point de jonction** des deux contrats de l'ADR 0001.
- **Le routing a besoin d'une clé** : le `chat_id` du channel ⟷ l'identité de conversation côté hub.
  Cette correspondance est l'**état runtime** du hub (qui-est-branché-où).
- **Le hub est state-ful** — deux états : (a) le **live**, la table des conversations à pipe vivant
  (qui-est-branché-où) ; (b) l'**history** de la conversation, qu'il **possède** en **format neutre**
  (ADR 0005 — pour ne dépendre ni d'un format de harnais, ni du PVC d'un runtime). Ce n'est donc
  **pas** « mince », mais ça reste **sans logique d'agent** (point suivant).
- **Aucune logique d'agent dans le hub** : ni prompt, ni outils, ni mémoire. Si on est tenté d'en
  mettre, c'est que ça appartient au **runtime** ou au **channel**.
- Détails (techno du serveur, forme de l'UI, protocole WS précis) = implémentation + `shared/`
  (ADR 0003), pas ici.

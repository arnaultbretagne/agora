# ADR 0002 — La primitive `channels` comme pipe

## Status

Proposed — 2026-06-30

## Context

Le pipe entre une conversation et le hub (ADR 0001), il faut le construire sur *quelque chose*.
Tentation : inventer notre transport — un WS maison qui « parle » au TUI, du scraping de stdout, ou
piloter `claude -p` / l'Agent SDK par messages.

Mais il y a une **contrainte dure** (`agent-runtime` ADR 0005) : rester sur l'**abonnement OAuth**,
le **TUI interactif** — **pas** l'API, **pas** `-p` / SDK (épée de Damoclès). Et Claude Code expose
**justement** une primitive native faite pour ça : `channels` (research preview, ≥ v2.1.80).

## Decision

**Le pipe = la primitive `channels` native de Claude Code. On ne réinvente rien.**

Un channel, concrètement :

- un **serveur MCP en stdio** que `claude` **spawn lui-même** (déclaré en config, capability
  `experimental: { 'claude/channel': {} }`) ;
- **inbound** (site → claude) : le channel **pousse** un événement via
  `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })` → claude
  le reçoit **dans la session vivante** sous la forme `<channel source="…" chat_id="…">…</channel>` ;
- **outbound** (claude → site) : le channel expose un **outil MCP `reply(chat_id, text)`** que claude
  appelle ;
- **permission-relay** (optionnel) : capability `claude/channel/permission` → le channel peut
  **relayer** les demandes de permission au site.

## Rationale

- **Abonnement-safe par construction.** Le channel **pousse dans le TUI interactif** qui tourne sur
  l'abonnement. On ne touche **jamais** à l'API ni à `-p`/SDK. C'est *le* mécanisme qui rend le
  produit compatible avec `agent-runtime` ADR 0005. Réinventer un transport = re-tomber vers `-p`/SDK
  = Damoclès.
- **Push-into-live-session.** Un channel n'est pas un RPC requête/réponse : il **injecte des
  événements dans une session qui tourne**. C'est exactement « parler à un agent vivant » — et ça
  explique la contrainte stdio (ci-dessous).
- **Natif = zéro glue fragile.** Pas de scraping de TUI, pas de PTY-parsing, pas d'heuristique « est-ce
  que claude a fini ». Le harnais fait le travail ; on consomme un **contrat documenté**.
- **Pourquoi stdio (et pas remote MCP / HTTP-SSE).** La primitive pousse *dans la session vivante* → le
  serveur de channel doit être **spawné par claude lui-même**, en **stdio**. Le **remote MCP (HTTP/SSE)
  ne s'applique pas** : il *sert des outils à la demande*, il ne **pousse pas** d'événements dans la
  boucle. ⇒ **le channel est co-localisé au runtime** — conséquence structurante (ADR 0001 / 0003).
- **Permission-relay = alternative propre au skip-perms.** Dans le pod-frontière (`agent-runtime`
  ADR 0003) on *peut* skip les permissions. Mais la primitive offre mieux : **relayer** la demande au
  site → l'humain tranche depuis le hub. On garde l'option ouverte (skip *dedans* OK ; relais *si* on
  veut la main).

## Consequences

- **Le channel n'est pas un service distant qu'on héberge** : c'est un **process spawné par claude**,
  en stdio, **dans le pod runtime**. Son *code* est produit (agora) ; son *lieu d'exécution* est le
  runtime → livré en **plugin** (ADR 0003), **pas** baké dans l'image.
- **Le channel a deux faces** : MCP-stdio côté claude (notifications inbound + `reply` outbound) et
  **WS** côté hub (le vrai « pipe » réseau). **C'est lui qui fait le pont stdio ⟷ WS.**
- Le **`chat_id`** de la primitive = la **clé de routing** d'une conversation, dont le hub se sert
  (ADR 0004).
- **Dépendance à une research preview.** `channels` est en preview (≥ v2.1.80) : la surface peut
  bouger. Mitigation : c'est **isolé dans un seul artefact** (le channel). On **assume** la preview —
  c'est le pari aligné avec la contrainte abonnement (les transports « stables » alternatifs sont
  justement ceux qu'on s'interdit).
- **fakechat** (Anthropic) est la **preuve** que ce design tient (channel + web UI) et notre
  **référence** (ADR 0006).

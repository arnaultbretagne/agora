# Options d'interface — notes pour l'ADR UI

Notes d'étude du 23 septembre 2026. Ce n'est pas une décision : ces notes gardent
la trace des candidats examinés et des raisons de leur retenue ou de leur refus,
pour l'ADR UI à venir.

## Découpage de départ

Agent Sandbox possède l'exécution, Agent Vault possède les credentials. Il reste à
Agora le journal des commandes et des échanges ACP, puis une interface qui en est
une vue. Chaque candidat a été évalué sur deux rôles possibles : servir d'interface,
ou remplacer ce journal.

## Piste retenue : assistant-ui

Version examinée : `@assistant-ui/react` 0.15.x.

- Bibliothèque de primitives de chat (fil, message, composer) sans style imposé,
  avec des variantes stylées optionnelles.
- Branchement par `ExternalStoreRuntime` : Agora fournit les messages et les
  callbacks (envoi, annulation, réponse de permission). L'interface n'affiche que
  ce que le journal projette. Les adaptateurs AG-UI et A2A de la bibliothèque
  reposent eux-mêmes sur ce runtime.
- AG-UI et A2A ne sont pas utilisés. A2A relie des agents entre eux. AG-UI suppose
  un run piloté par le client, alors qu'un tour Agora survit au navigateur et que
  le journal fait foi. Il n'existe aucun adaptateur ACP ; la projection
  ACP → messages reste chez Agora.
- Bonne correspondance avec ACP : texte et raisonnement en parties de message,
  `tool_call` et `tool_call_update` en parties outil avec statut,
  `session/request_permission` en validation humaine, `session/cancel` en `onCancel`.
- Restent spécifiques à Agora : livraison incertaine, frontières de Session,
  perte de contexte, arrêt avec nettoyage en attente, différences de capacités
  entre harnesses. L'édition, la régénération et les branches de la bibliothèque
  sont à désactiver.
- Coût : `@assistant-ui/core` est indépendant du framework, mais tout le rendu
  dépend de React (DOM, React Native, Ink). Adopter la bibliothèque veut dire
  adopter React et un bundler, contrairement au choix « sans framework » de
  l'implémentation précédente.
- Validation proposée : un spike sur `ExternalStoreRuntime`, alimenté par un
  journal ACP réel, avec une permission, une annulation et un rechargement en
  plein tour.

## Candidats écartés

Chaque dépôt a été cloné et son code lu. Les verdicts ci-dessous s'appuient sur le
code, pas sur la documentation du projet.

### acp-ui (formulahendry/acp-ui)

Client ACP en Vue et Tauri, v0.1.16, dernier commit en mai 2026, un seul mainteneur.

- Aucun stockage : les messages ne vivent qu'en mémoire, et l'historique dépend du
  rejeu `session/load` de l'agent.
- Pas de serveur : c'est le navigateur qui tient la connexion ACP, à l'inverse du
  modèle d'Agora.
- Un timeout de 60 s s'applique à toutes les requêtes, `session/prompt` compris.
  Tout tour de code réaliste échoue.
- La sortie de l'agent est rendue sans assainissement (`v-html`), d'où un risque
  XSS. La télémétrie est active par défaut.
- Aucun test TypeScript.

### AionUi (iOfficeAI/AionUi, backend AionCore)

L'interface Electron et React est populaire. Le vrai backend est AionCore, un
serveur Rust sur SQLite créé en avril 2026 (v0.2.2 à la date d'étude).

- Contredit les invariants du design :
  - le prompt est renvoyé automatiquement après une erreur, et c'est testé comme
    comportement voulu ;
  - une Session périmée est remplacée sans que la frontière soit enregistrée ;
  - l'état est perdu au redémarrage, et les tours en cours sont marqués terminés
    sans que l'utilisateur le voie ;
  - seules des vues assemblées sont stockées, jamais l'ACP brut.
- ACP ne passe que par un processus enfant stdio local. Claude et Codex
  contournent ACP (stream-json et `app-server`).
- Le build open source désactive l'authentification (`--local`). En mode
  `--remote`, une réinitialisation de mot de passe admin est possible sans
  authentification. Une partie de l'authentification est fermée.
- Une base verrouillée impose une seule réplique. L'activité s'effondre (6 commits
  en septembre contre plus de 1 400 en mars).

### agentrq (agentrq/agentrq)

File de tâches avec humain dans la boucle, construite sur MCP (Go, Vue). L'ACP ne
passe que par un gateway séparé.

- Ce n'est pas une interface de chat ACP. Le produit est centré sur les tâches et
  le kanban. Il n'affiche ni les appels d'outils ni le streaming.
- Le gateway ne sait lancer qu'un agent local en stdio. Il ne fait ni
  `session/load` ni reprise. Les messages de l'agent sont agrégés, et les appels
  d'outils ne sont pas conservés.
- La livraison repose sur la diffusion à toutes les sessions et sur un
  réessai toutes les 60 s. Il n'y a ni états de livraison ni identité de tour :
  une annulation tardive coupe le tour suivant.
- Il pourrait tourner à côté d'Agora comme tableau de tâches MCP, mais créerait
  un second historique du même travail.

## Conclusion provisoire

Aucun candidat ne remplace le journal : tous butent sur la livraison incertaine,
la reprise après redémarrage et l'attribution aux Sessions. Le journal reste la
brique propre à Agora. Pour l'interface, assistant-ui est la piste à valider par
le spike décrit plus haut.

# Éléments assistant-ui et ACP

Ce que chaque élément du registre assistant-ui ([assistant-ui.com/elements](https://www.assistant-ui.com/elements))
peut espérer recevoir d'un harness parlant ACP.

**Référence : la norme ACP 1.5.0** (schéma de `@agentclientprotocol/sdk` 1.5.0, 21 septembre 2026),
partie stable uniquement. Pas les extensions d'une implémentation particulière.

Chaque agent annonce ce qu'il supporte parmi la norme (`initialize`, capacités de session et de
prompt, options de configuration). Un élément « ACP » n'apparaît que si l'agent connecté fournit
la donnée ; l'interface masque le reste.

| Verdict | Sens |
| --- | --- |
| **ACP** | Alimenté par un message ACP stable. |
| **Agora** | Fourni par Agora ou le navigateur, sans rien demander à ACP. |
| **Partiel** | Une partie de l'élément tient, l'autre n'a pas de source. |
| **Non** | ACP ne transporte pas ce qu'il faut. |

## Tableau

| Éléments | Verdict | Source | Limite |
| --- | --- | --- | --- |
| streaming-text, message-pair, typing-indicator | **ACP** | `agent_message_chunk` ; `messageId` délimite les messages | — |
| reasoning-panel, reasoning | **ACP** | `agent_thought_chunk` | — |
| thinking-indicator | **ACP** | titre du dernier `tool_call` en cours | Durée calculée par Agora. |
| tool-call, tool-group, tool-timeline | **ACP** | `tool_call` / `tool_call_update` : sorte, titre, statut, fichiers touchés, entrée et sortie brutes | — |
| tool-error | **ACP** | statut `failed` d'un outil | Pas de « réessayer » : ACP ne relance pas un outil seul. |
| code-diff | **ACP** | contenu d'outil `diff` (chemin, ancien texte, nouveau texte) | — |
| terminal-block | **ACP** | contenu d'outil `terminal` et méthodes `terminal/*` | Agora tient le terminal : la sortie est lue en direct. |
| agent-plan, todo-list | **ACP** | `plan` : étapes, priorité, état | Trois états seulement ; pas d'étape « échouée ». |
| approval-card | **ACP** | `session/request_permission`, options `allow_once`, `allow_always`, `reject_once`, `reject_always` | — |
| elicitation-form | **ACP** | `elicitation` : formulaire décrit par un schéma, ou URL | Capacité à annoncer par Agora. |
| stopped-run | **ACP** | `session/cancel`, motif d'arrêt `cancelled` | « Continuer » est un nouveau prompt. |
| guardrail-notice | **ACP** | motif d'arrêt `refusal` | Pas d'alternatives proposées. |
| error-state | **ACP** | erreur du prompt, motifs `max_tokens`, `max_turn_requests` | « Réessayer » est un nouveau prompt. |
| model-picker, model-selector | **ACP** | options de configuration, catégorie `model` | Pas de prix ni de capacités par modèle. |
| context-display | **ACP** | `usage_update` : contexte utilisé et taille | — |
| message-attachment | **ACP** | blocs `image`, `audio`, `resource`, `resource_link` du prompt | Selon les types acceptés par l'agent. |
| agent-card | **ACP** | `initialize` : identité et capacités de l'agent ; commandes disponibles | — |
| reasoning-effort | **Partiel** | options de configuration, catégorie `thought_level` | Le budget consommé n'est pas connu. |
| cost-meter | **Partiel** | `usage_update.cost` | Total de la session seulement, pas par modèle. |
| context-breakdown | **Partiel** | `usage_update` | Total seulement, pas la répartition. |
| settings-panel | **Partiel** | options de configuration (`mode`, `model`, `thought_level`, booléens) | Prompt système et température seulement si l'agent les expose. |
| composer | **Partiel** | commandes (`available_commands_update`), pièces jointes, modèle | Mentions `@fichier` : la liste des fichiers vient du sandbox, pas d'ACP. Pas de voix. |
| reviewable-diff | **Partiel** | contenu d'outil `diff` | Décision sur l'appel d'outil entier, pas bloc par bloc. |
| permission-grant | **Partiel** | option `allow_always` | La portée de l'autorisation n'est pas décrite. |
| file-tree | **Partiel** | fichiers touchés et diffs des outils | Reconstruit par Agora. |
| image-generation | **Partiel** | bloc `image` dans la réponse | L'image arrive entière, sans progression. |
| web-search, sources, document-reference | **Partiel** | outils `search` / `fetch`, blocs `resource_link` | Pas de citations structurées. |
| subagent-list, task-card, agent-handoff | **Partiel** | appels d'outil, si l'agent y expose ses sous-agents | ACP ne connaît pas les sous-agents. |
| message-actions | **Partiel** | — | Copier et noter : oui. Régénérer : non (voir regenerate-menu). |
| mcp-server-panel | **Partiel** | serveurs MCP déclarés par Agora à la création de la session | Pas d'état des serveurs ; connexion dynamique instable. |
| thread-list, thread-search, conversation-search, shared-conversation | **Agora** | journal Agora ; titre par `session_info_update` | ACP a aussi `session/list`, mais le journal fait foi. |
| speaker-identity | **Agora** | attribution des échanges aux Sessions | — |
| connection-state, agent-status, loading-state | **Agora** | état de la connexion et du tour | — |
| message-timing | **Agora** | horodatage des trames | Débit en jetons approximatif. |
| message-queue | **Agora** | file côté client | À arbitrer avec la règle d'un seul tour actif. |
| feedback-dialog | **Agora** | stocké par Agora | Rien ne remonte à l'agent. |
| quote-reply, draft-restore | **Agora** | composer | — |
| directive-text | **Agora** | rendu des commandes et mentions dans le message | — |
| prompt-library | **Agora** | prompts enregistrés par Agora | — |
| activity-graph | **Agora** | statistiques du journal | — |
| math-block, diagram, mermaid-diagram, shiki-highlighter | **Agora** | rendu du texte Markdown | — |
| read-aloud | **Agora** | synthèse vocale du navigateur | — |
| chat-panel, empty-state, scroll-anchor, conversation-map, day-separator, command-palette, launcher-bubble, mobile-composer, onboarding | **Agora** | interface seule | — |
| edit-message, message-branches, regenerate-menu | **Non** | — | Ni édition ni retour en arrière. `session/fork` est instable. |
| suggestions | **Non** | — | Agora pourrait les générer à part. |
| voice, voice-conversation | **Non** | — | Pas d'audio en temps réel. |
| recommendation-card | **Non** | — | La permission est le seul accord prévu. |
| inline-citation, retrieval-chunks, confidence-marker | **Non** | — | Pas de citations ni de degré de confiance. |
| data-table, chart, number-ticker, spec-sheet, comparison-card, timeline, map-answer, score-breakdown, research-report, job-progress | **Non** | — | ACP ne transporte que Markdown, images et ressources. Un tableau Markdown reste possible. |
| artifact-card, canvas-split | **Non** | — | Pas d'artefact : les fichiers passent par les diffs. |
| trace-waterfall, flow-graph | **Non** | — | Pas de spans ni de graphe d'exécution. |
| computer-use, code-runner, web-preview | **Non** | — | Hors ACP ; un aperçu web passerait par Agent Sandbox. |
| memory-chips, checkpoint-history, background-inbox, schedule-card, quota-banner | **Non** | — | — |

## Instable, à surveiller

Ces messages existent dans le schéma 1.5.0 mais restent marqués instables :
`plan_update` et `plan_removed` (plan partiel), `notice`, `compaction_update`, les fournisseurs,
la connexion MCP dynamique, et surtout `session/fork`, qui ouvrirait les branches.

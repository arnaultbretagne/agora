# Interface Agora ↔ assistant-ui

Contrat de départ à implémenter — `@assistant-ui/react` **0.15.21**.

**Agora détient le fil et les commandes. assistant-ui affiche le fil et remonte
les gestes de l'utilisateur.**

Les options étudiées avant ce choix sont dans [ui-options.md](ui-options.md).

## Qui fait quoi ?

- **Le serveur Agora** projette le journal ACP en tours, éléments et avis, en base,
  et applique les commandes.
- **Le client Agora** tient le fil reçu en mémoire, le convertit en messages
  assistant-ui et transforme les gestes en commandes.
- **assistant-ui** fournit le runtime `useExternalStoreRuntime`, les primitives
  et les composants du registre.

Les composants du registre sont copiés dans le code d'Agora (`npx assistant-ui add
<nom>`, modèle shadcn) : on les modifie librement. Seuls `@assistant-ui/react` et
son runtime sont des dépendances.

L'interface n'invente aucun état. Même le message que l'utilisateur vient d'écrire
n'apparaît qu'une fois enregistré par le serveur. L'effet d'une commande se lit
dans le fil, jamais dans la réponse à la commande.

## Les trois échanges

| Échange | Contenu |
| --- | --- |
| **Liste des workstreams** | Lecture simple : identifiant, titre, état de l'exécution. |
| **Fil d'un workstream** | Un flux unique, ouvert depuis la dernière position connue (zéro au départ). Il envoie d'abord l'état actuel de ce qui a changé depuis, puis chaque changement. Chaque envoi remplace un objet entier : workstream, tour, élément ou avis. |
| **Commandes** | Créer, Écrire, Annuler, Répondre à une permission, Arrêter. |

Chaque envoi du fil porte une position strictement croissante. Ouvrir, recharger
et se reconnecter sont le même geste : rien n'est perdu, rien n'est reçu deux fois.

Chaque commande porte un identifiant choisi par l'interface. Rejouée, elle n'est
exécutée qu'une fois. La réponse du serveur est *acceptée* ou *refusée, avec la
raison*.

| Commande | Porte | Règle |
| --- | --- | --- |
| **Créer** | le harness choisi parmi les options autorisées | — |
| **Écrire** | le texte | Refusée si un tour est enregistré ou en cours, ou si les envois sont fermés. |
| **Annuler** | le tour visé | Sans effet si ce tour est clos ; ne touche jamais le tour suivant. |
| **Répondre à une permission** | la demande et l'option choisie | Refusée si la demande n'est plus en attente. |
| **Arrêter** | — | Ferme les envois ; l'exécution disparaît dès que sa suppression est acceptée. |

## Le pont : `useExternalStoreRuntime`

C'est le seul point de contact entre les données d'Agora et assistant-ui.

| Propriété | Alimentée par |
| --- | --- |
| `messages` + `convertMessage` | Tours et avis du fil. Un tour donne un message `user` et un message `assistant` ; un avis donne un message `system`. |
| `isRunning` | Le dernier tour est enregistré ou en cours. |
| `isSendDisabled` | Envois fermés : exécution en démarrage ou en erreur, stockage indisponible. |
| `isDisabled` | Workstream arrêté : le fil reste lisible. |
| `onNew` | **Écrire** |
| `onCancel` | **Annuler**, sur le tour en cours connu de l'interface. |
| `onRespondToToolApproval` | **Répondre à une permission** : `approvalId` = la demande, `optionId` = le choix. |
| `adapters.threadList` | La liste des workstreams (voir la barre latérale). |

Non fournis, donc fonctions absentes de l'interface : `onEdit`, `onReload`,
`onDelete`, `setMessages`, `queue`, `suggestions` et les adaptateurs `attachments`,
`feedback`, `speech`, `dictation`.

## Les états d'un tour

| Tour | Message utilisateur | Réponse (`status`) |
| --- | --- | --- |
| **enregistré** — écrit par Agora, pas encore envoyé | badge « enregistré » | `running`, vide : indicateur ● |
| **en cours** — envoyé, la réponse arrive | — | `running` |
| **terminé** — l'agent a fini | — | `complete` |
| **annulé** — arrêté à la demande | — | `incomplete` / `cancelled` ; une permission en attente passe à `resolution: cancelled` |
| **échoué** — l'agent a répondu par une erreur | — | `incomplete` / `error`, avec le message |
| **incertain** — connexion perdue pendant le tour | badge « incertain », bien visible | `incomplete` / `other`, avec l'explication |

Un tour incertain n'est jamais renvoyé automatiquement. Il ne change d'état que sur
preuve. L'état du tour voyage dans `metadata.custom` du message utilisateur.

## L'écran, zone par zone

### Barre latérale

| Élément | Composant | Branchement |
| --- | --- | --- |
| Liste des workstreams | `ThreadList` (registre) | `threadList.threads` : id, titre ; état de l'exécution dans `custom` |
| Ouvrir un workstream | `ThreadListItemPrimitive.Trigger` | `onSwitchToThread` → ouvre le fil |
| Nouveau workstream | `ThreadListPrimitive.New` + choix du harness (**à nous**) | `onSwitchToNewThread` → choix → **Créer** |
| État de l'exécution | `Badge` (registre) | démarrage, disponible, erreur, arrêtée |

### Fil

| Élément | Composant | Branchement |
| --- | --- | --- |
| Conteneur, défilement | `Thread` (registre) | — |
| Message utilisateur | `UserMessage` (dans `Thread`) + badge d'état du tour | `role: user` |
| Réponse de l'agent | `AssistantMessage` (dans `Thread`) | `role: assistant`, `status` selon les états du tour |
| Erreur d'un tour | `MessagePrimitive.Error` (déjà dans `AssistantMessage`) | tour échoué |
| Avis | `Notice` (**à nous**) | `role: system`, code dans `metadata.custom` |
| Démarrage, erreur de l'exécution | bandeau d'exécution (**à nous**) | état de l'exécution du workstream |
| Connexion au fil perdue | `ConnectionState` (registre `elements-connection-state`) | état du flux dans le navigateur, pas une donnée Agora |

`Thread` rend aujourd'hui tout message non `user` comme une réponse : on lui ajoute
le cas `system` → `Notice`.

Avis : session démarrée, session terminée, contexte perdu, harness perdu.

### Blocs d'une réponse

Construits sur le serveur, en base, à partir du journal ACP.

| Élément | Construit à partir de | Part assistant-ui | Composant |
| --- | --- | --- | --- |
| **Texte** | fragments de message consécutifs | `text` | `MarkdownText` (registre) |
| **Réflexion** | fragments de pensée consécutifs | `reasoning` | `Reasoning` (registre), regroupé automatiquement |
| **Outil** | l'appel puis ses mises à jour, fusionnés | `tool-call` | `ToolFallback` (registre), modifié pour afficher le titre ; outils consécutifs regroupés par `ToolGroup` (registre) |
| **Outil `edit`** | idem | idem | `DiffViewer` (registre) via `makeAssistantToolUI` |
| **Outil `execute`** | idem | idem | `TerminalBlock` (registre `elements-terminal-block`) via `makeAssistantToolUI` |
| **Permission** | la demande ACP, rattachée à son outil | champ `approval` du `tool-call` | boutons déjà présents dans `ToolFallback` |
| **Plan** | le dernier plan reçu dans le tour | `data` nommée `plan` | `TodoList` (registre `elements-todo-list`) via `makeAssistantDataUI` |

Correspondances de champs :

- **Outil** — `toolCallId` = id ACP ; `toolName` = sorte ACP (`read`, `edit`,
  `execute`…) ; `args` = entrée ; `result` = résultat ; `isError` = échec ;
  `artifact` = titre et emplacements.
- **Diff** — `DiffViewer` reçoit directement le diff ACP : chemin, ancien texte,
  nouveau texte.
- **Permission** — `approval.id` = la demande ; `approval.options` = les options ACP.
  Les quatre sortes sont identiques des deux côtés : `allow-once`, `allow-always`,
  `reject-once`, `reject-always`. `approval.optionId` = la réponse.
- **Plan** — `pending` / `in_progress` / `completed` deviennent `pending` / `active` /
  `done`.

### Composer

| Élément | Composant | Branchement |
| --- | --- | --- |
| Saisie | `ComposerPrimitive.Input` | — |
| Envoyer | `ComposerPrimitive.Send` | `onNew` → **Écrire** |
| Stop | `ComposerPrimitive.Cancel`, visible pendant un tour | `onCancel` → **Annuler** |
| Raison de fermeture | bandeau au-dessus du composer (**à nous**) | envois fermés |

À retirer des composants copiés : `BranchPicker`, les actions Edit, Reload et
Feedback, `EditComposer`, les pièces jointes et la dictée. Copier reste.

## Hors de ce contrat, déjà disponible

| Besoin futur | Composant existant |
| --- | --- |
| Changer de modèle ou de mode | `ModelSelector` (registre) |
| Commandes slash (`available_commands` ACP) | `ComposerTriggerPopover` (registre) |
| Consommation de contexte (`usage` ACP) | `ContextDisplay` (registre) |
| Pièces jointes | `Attachment` (registre) |

## Les composants à écrire

`Notice`, le choix du harness, le badge d'état du tour, le bandeau d'exécution et
le bandeau de fermeture des envois. Tout le reste vient du registre ou des primitives.

**À préciser :** blocage de l'écriture après un tour incertain (décision 5 du
design), pagination des fils longs, et version d'assistant-ui figée —
`adapters.threadList`, `onSwitchToThread` et `onSwitchToNewThread` sont marqués
instables en 0.15.

Références : [ExternalStoreAdapter](https://github.com/assistant-ui/assistant-ui/blob/main/packages/core/src/runtimes/external-store/external-store-adapter.ts),
[registre des composants](https://r.assistant-ui.com/registry.json).

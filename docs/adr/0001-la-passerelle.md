# ADR 0001 — La passerelle d'Agora est la seule sortie des exécutions

- **Statut :** acceptée
- **Date :** 29 septembre 2026
- **Remplace :** les ADR 0009 (« OneCLI est la seule autorité sur les droits externes ») et 0010
  (« Les capacités se compilent en droits OneCLI ») de l'implémentation précédente.
- **Contrat :** [credentials.md](../credentials.md).

## Contexte

Un harness tourne dans un sandbox que l'on tient pour hostile : tout outil installé peut être
appelé, tout fichier lu. Il a pourtant besoin de services externes, Claude pour le modèle, GitHub
pour le code. Un credential posé dans le sandbox peut être copié et réutilisé hors de tout
contrôle, y compris après la fin de l'exécution.

Les droits changent d'une exécution à l'autre et se combinent : Claude, plus l'écriture sur un
repo, plus la lecture d'un autre, les deux sur le même hôte GitHub. Le nombre de combinaisons
croît vite : deux repos à deux niveaux et deux fournisseurs de modèle en donnent déjà une
dizaine.

Le sandbox est démarré dans un pool chaud, avant que l'exécution existe : son environnement ne
peut porter aucun jeton qui lui serait propre.

## Décision

1. **Aucun credential dans le sandbox.** Sa seule sortie réseau est la passerelle d'Agora,
   agentgateway, atteinte par le proxy local du bridge.
2. **Agora signe les droits.** Pour une exécution, Agora compile des profils (`anthropic`,
   `github:owner/repo:read`, `github:owner/repo:write`) en droits — un hôte, un chemin, des
   méthodes — et les signe dans un JWT court. Le bridge le reçoit après le claim et le joint à
   chaque connexion sortante.
3. **La passerelle décide, puis pose le credential.** Elle vérifie le JWT, puis chaque requête
   contre ses droits, avec une règle unique pour tous les hôtes. Si la requête est permise, elle
   pose le credential de l'hôte, qu'elle seule détient, en Secret Kubernetes chiffré par SOPS.
4. **Le credential fixe le maximum, les droits le découpent.** Un credential par hôte, aussi
   étroit que possible (un PAT limité aux repos qu'Agora peut toucher) ; chaque exécution n'en
   reçoit que la part que ses profils accordent.

## Pourquoi

- **La composition ne coûte rien.** N'importe quelle combinaison de profils tient dans un
  jeton ; aucune entité n'est créée ni nettoyée par exécution ou par combinaison.
- **Les secrets ne sont qu'à un endroit.** Agora signe des droits sans voir un credential ; le
  sandbox ne détient qu'un jeton qui expire, utilisable seulement à travers la passerelle et
  seulement pour ses droits.
- **Une règle, un journal.** Chaque décision passe par la même règle ; chaque requête laisse une
  ligne avec l'exécution, la méthode, le chemin, le statut et la raison d'un refus.
- **Les secrets vivent comme le reste de l'infrastructure.** Un commit SOPS les change ; la
  passerelle les recharge sans redémarrer.

Mesuré le 29 septembre sur g4 sous Kata : avec un PAT capable d'écrire sur deux repos, une
exécution accordée « écriture sur A, lecture sur B » a créé un fichier sur A et s'est vu refuser
la même écriture sur B par la passerelle ; Haiku répond à travers elle
([credentials.md](../credentials.md), cas 23 à 26).

## Ce qu'on a essayé

### OneCLI 1.45, la passerelle de l'implémentation précédente

OneCLI gardait les credentials, les injectait, et accordait à chaque *Agent* OneCLI une sélection
de secrets. L'implémentation précédente liait un Agent à chaque incarnation de Pod et
réconciliait ses droits.

Abandonné pour son modèle d'identité :

| Constat | Conséquence |
| --- | --- |
| Un Agent a un jeton permanent (`aoc_…`), sans expiration ni révocation propre. | Pour borner une exécution, Agora devait créer puis supprimer un Agent à chaque fois. |
| La création n'est pas idempotente : 409 si l'identifiant existe, et aucune recherche par identifiant. | Une réponse perdue obligeait à tout relister pour retrouver l'Agent. |
| `GET /agents` renvoie le jeton de chaque Agent en clair. | Quiconque liste les Agents peut se faire passer pour chacun d'eux. |
| Un second secret du même type cassait la résolution des droits. | Deux credentials pour le même hôte ne cohabitaient pas. |
| La gestion passe par la clé d'API du projet (`oc_…`). | Agora détenait une clé d'administration de la passerelle. |

### OneCLI 2.x

La v2.0 (18 août 2026) a transformé OneCLI en plateforme d'agents hébergés : un sandbox durable
par agent, un runner, un superviseur, Slack. Cela recouvre ce que font Agora et Agent Sandbox.
Lu dans le code de la v2.6.0 :

| Constat | Conséquence |
| --- | --- |
| Toujours un jeton permanent par agent ; aucune route ne prend de durée de vie. | Pas d'identité par exécution qui expire. |
| Les groupes d'agents sont supprimés ; un droit est une règle « un agent, un secret ». | Composer reste possible, mais sur un agent permanent, en réécrivant toute la policy du workspace à chaque droit. |
| Deux secrets pour le même hôte : l'ordre est celui où la base rend les lignes. | Le credential posé n'est pas déterministe. |
| Contrôle des rôles et portée fine sous licence entreprise. | Hors de la version libre. |
| Migration depuis 1.45 : tables supprimées, API en 410, sans retour arrière. | Un coût de migration sans le gain recherché. |

### Agent Vault 0.39.3 (Infisical)

Monté et mesuré le 28 septembre : le proxy du bridge vers le proxy MITM d'Agent Vault, une session
`proxy` frappée par Agora pour chaque exécution. Haiku a répondu à travers lui ; la chaîne, le
bridge et la remise après le claim ont été conservés tels quels pour la passerelle.

Abandonné parce qu'il ne compose pas, et pour ce qu'il exige d'Agora :

| Constat | Conséquence |
| --- | --- |
| Une session couvre un vault entier ; rien ne restreint une session à certains services ; les services ne distinguent pas les méthodes HTTP. | « Écriture sur A, lecture sur B » n'est pas exprimable. |
| Une requête passe par un seul vault. Un vault par profil obligerait le bridge à choisir la session selon l'hôte, mais le chemin est dans le TLS. | Deux profils sur le même hôte ne se combinent pas. |
| Frapper une session exige le rôle `member`, qui peut aussi lire, poser et supprimer les credentials du vault. | Agora aurait accès à tous les secrets qu'il distribue. |
| D'après sa documentation, l'édition entreprise ajoute des filtres par méthode et chemin, mais garde une session par vault et refuse deux services sur le même hôte. | Même limite, sous licence. |

### Un credential court par exécution

Proposé pour GitHub : émettre à chaque exécution un jeton d'installation d'une GitHub App limité
aux repos et aux droits voulus. Écarté : de l'état et du nettoyage dans Agora pour chaque
exécution, et une composition portée par le credential plutôt que par la policy, qui ne vaut que
pour GitHub.

### Un vault par combinaison

Écarté d'emblée : le nombre de vaults suit celui des combinaisons.

### Les autres passerelles regardées

| Candidat | Pourquoi non |
| --- | --- |
| Octelium | Compose nativement, mais en proxy inverse seulement (réécrire les adresses de base, pénible pour `gh`), sous AGPL, maintenu par une seule personne, installation lourde. |
| Envoy avec OPA | Le repli sérieux : briques mûres, contrôle du GraphQL possible. Mais c'est construire notre propre passerelle. |
| Pomerium, Teleport, StrongDM, Aembit, Keycard, Tailscale Aperture | Proxy inverse, pas de règles par chemin et méthode, secret dans le Pod, ou service hébergé. |
| LiteLLM, Kong, Envoy AI Gateway | Modèles de langage seulement : ni git ni GitHub. |
| tokenizer (Fly.io) | Le modèle de sécurité le plus élégant, mais refuse `CONNECT` et n'a plus eu de version depuis 2023. |

## Conséquences

- La passerelle est sur le chemin critique : si elle tombe, les opérations externes échouent,
  sans escalade automatique des droits.
- Un nouvel hôte demande une route dans la configuration de la passerelle et un profil dans le
  catalogue d'Agora, revus comme du code.
- Un JWT ne se révoque pas avant son expiration : il reste court, et Agora le réémet pendant la
  vie de l'exécution.
- Le GraphQL de GitHub reste fermé : on ne peut pas y vérifier le repo visé.
- git et codex doivent faire confiance à l'autorité de la passerelle par d'autres moyens que
  `NODE_EXTRA_CA_CERTS`.
- agentgateway est jeune et évolue vite (la 1.5 a rendu `iss` et `aud` obligatoires) : image
  épinglée par digest, montées de version délibérées, cas du banc rejoués avant.
- Changer de passerelle demande un nouvel ADR ; le contrat du bridge (`PUT /credentials`, jeton
  joint au `CONNECT`) ne dépend pas d'elle.

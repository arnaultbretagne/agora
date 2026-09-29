# credentials

Les credentials d'une exécution, côté Agora ([docs/credentials.md](../../docs/credentials.md)).
Deux sources : frapper une session `proxy` dans Agent Vault avec le jeton d'agent d'Agora, ou
compiler des profils en droits et les signer dans un JWT court pour la passerelle. Remettre l'un
ou l'autre au bridge est le travail des exécutions (`POST /api/executions/{nom}/credentials`).

| Dossier | Contenu |
| --- | --- |
| [src/](src/) | Le client Agent Vault ; le catalogue des profils et la signature des droits. |
| [test/](test/) | La frappe, contre une fausse API Agent Vault ; la compilation des profils et le JWT. |

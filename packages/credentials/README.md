# credentials

Les credentials d'une exécution, côté Agora ([docs/credentials.md](../../docs/credentials.md)) :
frapper une session `proxy` dans Agent Vault avec le jeton d'agent d'Agora. La remettre au
bridge est le travail des exécutions (`POST /api/executions/{nom}/credentials`).

| Dossier | Contenu |
| --- | --- |
| [src/](src/) | Le client Agent Vault. |
| [test/](test/) | La frappe, contre une fausse API Agent Vault. |

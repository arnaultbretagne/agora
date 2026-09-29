# credentials

Les credentials d'une exécution, côté Agora ([docs/credentials.md](../../docs/credentials.md)) :
compiler ses profils en droits et les signer dans un JWT court pour la passerelle. Agora ne voit
aucun credential. Remettre le jeton au bridge est le travail des exécutions
(`POST /api/executions/{nom}/credentials`).

| Dossier | Contenu |
| --- | --- |
| [src/](src/) | Le catalogue des profils et la signature des droits. |
| [test/](test/) | La compilation des profils, leur composition, et le JWT. |

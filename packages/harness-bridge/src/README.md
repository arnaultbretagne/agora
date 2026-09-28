# src

| Fichier | Rôle |
| --- | --- |
| `main.ts` | Point d'entrée des images : configuration par l'environnement, poussée de l'anchor au SIGTERM. |
| `server.ts` | Le bridge : adaptateur, relais numéroté, rejeu, routes, fin du Pod. |
| `token.ts` | Le jeton Ed25519 d'Agora : signature (Agora) et vérification (bridge). |
| `anchor.ts` | L'anchor : dossier natif de chaque harness, lecture en bloc, poussée, restauration. |
| `index.ts` | Ce que le paquet exporte. |

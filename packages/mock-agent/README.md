# mock-agent

L'agent ACP du banc : aucun modèle, un comportement choisi par le texte du prompt, et un vrai
fichier natif sous `$HOME/.mock-agent/sessions/`, relu à `session/resume` et `session/load`.

| Prompt | Comportement |
| --- | --- |
| texte libre | Écho numéroté, avec le message précédent. |
| `/sleep N` | Un fragment par seconde pendant N secondes. |
| `/silence N` | Rien pendant N secondes, puis une réponse. |
| `/permission` | Demande une permission et attend la réponse. |
| `/tool` | Un appel d'outil avec un diff. |
| `/big N` | N Kio de texte. |
| `/recall` | Rappelle tout ce qui a été dit dans la session. |
| `/crash` | Sort avec le code 3. |
| `/fetch URL` | Un GET par `HTTPS_PROXY`, comme un vrai harness ([docs/credentials.md](../../docs/credentials.md)) ; répond ce qui est revenu. |

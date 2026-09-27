# src

| Fichier | Rôle |
| --- | --- |
| `main.ts` | Point d'entrée : configuration, démarrage du service et du récepteur d'anchors. |
| `manager.ts` | Le cœur : claims, connexion à chaque bridge, tours, échéance, restauration, réception. |
| `kube.ts` | Les appels à l'API Kubernetes, et rien d'autre (jamais de suppression). |
| `http.ts` | L'API, le flux SSE, le relais WebSocket du consommateur et le récepteur d'anchors. |
| `anchors.ts` | Le stockage des anchors. |

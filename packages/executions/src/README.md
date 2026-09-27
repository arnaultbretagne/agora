# src

| Fichier | Rôle |
| --- | --- |
| `manager.ts` | `ExecutionManager` : claims, connexion à chaque bridge, tours, échéance, restauration, réception des anchors. |
| `kube.ts` | Les appels à l'API Kubernetes, et rien d'autre (jamais de suppression). |
| `http.ts` | L'API, le flux SSE, le relais WebSocket du consommateur et le récepteur d'anchors. |
| `anchors.ts` | Le stockage des anchors. |
| `index.ts` | Ce que le paquet exporte. |

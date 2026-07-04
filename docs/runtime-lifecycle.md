# Runtime d'une conversation — spawn, seed, resume, fallback

Comment le hub fait vivre, mourir et renaître le runtime qui sert une conversation.
Couvre tous les cas : premier message, réouverture, reprise native (`--resume`), transcript
disparu, crash, redémarrage du hub, runtime muet.

Références : ADR 0005 (re-seed), ADR 0007 (resume ancre + delta), ADR 0008 (autorité d'état,
reaper). État du code : Phase 4 déployée (`7bbd932`, `94ff374`, `739beda`, fix fallback
`e823795` ; agent-runtime `57cfa4b`). Vérifié en prod le 2026-07-04 : verrou C4 (resume,
fallback, re-claim) + probe cross-model (`--resume` + `--model`, scénario 12).

---

## 1. Vocabulaire — sept termes, pas un de plus

| terme | définition exacte |
|---|---|
| **conversation** | L'objet du hub : la suite des messages, chacun numéroté par `seq` (1, 2, 3, …). C'est **la source de vérité** (ADR 0005) — persistée en Postgres, sauvegardée. |
| **runtime** | Un process `claude` lancé par le superviseur pour servir *une* conversation. Identifiant superviseur : `<convId>-rN` (N = numéro de tentative). Jetable. |
| **session native** | La session interne de claude : le transcript `~/.claude/projects/<slug>/<uuid>.jsonl` sur le PVC. L'uuid est choisi par le hub, pas par claude. **Accélérateur jetable** : ni sauvegardé, ni garanti d'exister encore demain. |
| **ancre** | `conv.natives[kind] = { sessionId, syncedSeq }`. En clair : « la dernière session native qui a *réellement répondu*, et le `seq` du dernier message du hub qui lui a été remis ». Borne **exacte**, pas une estimation — voir « sur quoi porte le pari », §2. Une ancre par **kind** (harness) — pas par modèle : changer le modèle d'une conversation garde la même ancre (scénario 12). C'est tout ce qu'on retient d'un runtime mort. |
| **seed complet** | Rejouer l'historique du hub (les 80 derniers tours max) en un seul message texte au démarrage d'un runtime à froid (ADR 0005). Le **plancher de correction** : toujours possible, toujours juste, juste lent. |
| **delta-seed** | Ne rejouer *que* les tours du hub postérieurs à `syncedSeq` (ADR 0007) — la session native reprise connaît déjà le reste. |
| **pending / pipe** | Les deux états en RAM du hub pour un runtime : `pending` = lancé (ou à re-réclamer), channel pas encore connecté ; `pipe` = channel WebSocket connecté. |

Deux identifiants à ne pas confondre : l'**id superviseur** (`<convId>-rN`) désigne le *process* ;
l'**uuid natif** désigne le *transcript*. Le pari `--resume` porte sur l'uuid natif ; les
détecteurs de mort interrogent l'id superviseur.

---

## 2. Le principe en quatre phrases

1. **Au spawn, le hub choisit à l'avance** : s'il possède une ancre pour ce `kind`, il parie
   dessus (`--resume <uuid>`) ; sinon il part à froid (`--session-id <uuid neuf>`).
2. **Le pari est aveugle.** Rien ne permet de vérifier *avant* que le transcript existe encore ;
   on lance et on regarde ce qui se passe. C'est le « resume optimiste » de l'ADR 0007.
3. **Le succès n'a qu'une seule preuve : une réponse arrive.** À cet instant — et jamais avant —
   l'ancre est écrite ou avancée.
4. **L'échec n'a qu'une seule forme : le runtime meurt sans avoir jamais répondu.** Si c'était un
   pari, le hub efface l'ancre et relance *une seule fois* à froid, avec seed complet.
   L'utilisateur reçoit quand même sa réponse — juste plus lentement.

Le hub ne cherche jamais *pourquoi* un runtime est mort (pas de lecture de stderr, pas de
distinction « transcript absent » / autre crash) : le remède serait identique, donc la cause
est ignorée volontairement.

**Sur quoi porte le pari — et sur quoi il ne porte pas.** Le pari ne porte jamais sur le
*contenu* de la session native : le hub le connaît exactement, parce que c'est lui qui l'a
construit — rien n'entre dans un runtime de conversation autrement que par le pipe (la seule
interface d'un runtime est le pipe neutre ; l'utilisateur ne parle jamais directement à claude).
L'ancre mémorise la frontière : tout message de `seq ≤ syncedSeq` a été remis à cette session
via le pipe, et la réponse enregistrée à cet instant-là prouve qu'elle les digérait. La seule
inconnue — le pari — est l'**existence** : le fichier transcript est-il encore là ? Le delta se
calcule donc **en local, avant le spawn, par soustraction entre deux données que le hub
possède** (son historique numéroté par `seq`, et `syncedSeq`) — jamais en inspectant le
transcript ni en interrogeant claude. Et si le pari échoue, le delta-seed poussé se perd avec
le runtime mort, sans conséquence : pousser un message ne le consomme pas — chaque attache
re-dérive ce qu'il faut livrer depuis l'historique, et le respawn de secours rejoue tout en
seed complet.

---

## 3. L'arbre complet

```
message utilisateur, conversation sans runtime
│
├─ DÉCISION 1 — au spawn (#spawnFor) : une ancre existe-t-elle pour conv.kind ?
│    NON → lance `claude --session-id <uuid neuf>`   ── départ à froid
│    OUI → lance `claude --resume <uuid de l'ancre>` ── pari : le transcript existe encore
│
├─ le channel s'attache (~40 ms) : tuyauterie branchée — ne prouve RIEN sur le pari
│
├─ DÉCISION 2 — à l'attache (#deliverBacklog) : que pousser au runtime ?
│    départ à froid + historique non vide → SEED COMPLET (replay ≤ 80 tours + nouveaux msgs)
│    départ à froid + aucun historique    → push simple (tout premier message)
│    pari resume  + tours manqués         → DELTA-SEED (tours > syncedSeq + nouveaux msgs)
│    pari resume  + rien manqué           → push simple (cas nominal)
│    re-claim (runtime déjà vivant)       → push simple — on ne re-seede JAMAIS un vivant
│
└─ ISSUE — deux événements possibles, un seul arrivera :
     │
     ├─ une réponse arrive (tool `reply`) ──────────────────────────→ SUCCÈS
     │    l'ancre est écrite/avancée : { uuid natif, syncedSeq = seq de la réponse }
     │    (seul endroit du code qui écrit une ancre : onChannelReply)
     │
     └─ le runtime meurt sans avoir répondu (vu par un des 3 détecteurs, §6)
          │
          ├─ resume ∧ ¬replied ∧ ¬retriedFresh → FALLBACK, une seule fois :
          │     1. effacer l'ancre morte        (setNativeHandle null)
          │     2. respawn immédiat forceFresh  (#spawnFor { forceFresh: true })
          │     → re-rentre en DÉCISION 1, branche NON → seed complet
          │
          └─ sinon → classement normal :
                code de sortie ≠ 0        → error
                sortie propre / disparu   → dormant
```

Tout scénario réel (§7) est un chemin dans cet arbre. Il n'y a pas d'autre logique.

---

## 4. Les trois drapeaux

Portés par la tentative en cours (`pending` puis `pipe`), jamais persistés :

| drapeau | signifie | posé où | lu où |
|---|---|---|---|
| `resume` | ce runtime a été lancé avec `--resume` | au spawn, figé | par les 3 détecteurs de mort |
| `replied` | ce runtime a déjà livré au moins une réponse | `false` au départ ; passe à `true` en **un seul point du code** : `onChannelReply` | par les 3 détecteurs de mort |
| `retriedFresh` | ce runtime **est** le retry du fallback | au spawn, `true` ssi `forceFresh` | bloque un second fallback |

Et l'ancre n'a que **trois points de contact** dans tout le code :
lue dans `#spawnFor` (décision 1) · écrite dans `onChannelReply` (succès) · effacée dans
`#fallbackToFreshResume` (échec). Rien d'autre n'y touche.

---

## 5. Pourquoi « une réponse reçue » est le seul signal de succès

C'est le point qui a créé toute la confusion, donc chronologie mesurée (verrou C4, prod) d'un
`--resume` dont le transcript a disparu :

```
t0          POST /sessions → node-pty lance `claude --resume <uuid> --channels …`
t0 + ~40 ms le plugin channel (serveur MCP embarqué dans le process claude) démarre,
            ouvre son WebSocket vers le hub, hello → pipe « connecté »
peu après   claude énumère les outils MCP (ListTools) → le channel émet `ready` → conv « live »
ensuite     claude tente ALORS SEULEMENT de charger la session à reprendre :
              transcript présent → boucle d'agent → tool `reply`      → succès
              transcript absent  → « No conversation found with session ID: … » → exit 1
```

Le channel connecté et la frame `ready` sont des signaux de **boot de la tuyauterie MCP**. Ils
arrivent *avant* que claude ne touche au transcript, donc ils se produisent **que le pari soit
bon ou pas**. Ils ne peuvent rien prouver.

Une réponse, en revanche, exige que claude ait fini son boot, chargé son contexte et traité un
tour dans sa boucle d'agent. Or un `--resume` raté tue le process *avant* la boucle d'agent
(vérifié C0 et C4) : **il est impossible de recevoir une réponse d'un resume raté**. D'où
l'équivalence sur laquelle tout repose :

> réponse reçue ⇔ le runtime fonctionne (et si c'était un pari, le pari est gagné).
> mort sans réponse ⇔ ce runtime n'a jamais fonctionné.

Il n'y a donc **pas de « détection du --resume qui échoue »** : on ne détecte que la mort, et on
en *déduit* l'échec du pari par `resume ∧ ¬replied`.

---

## 6. La mort et ses trois détecteurs

Un runtime peut mourir à trois moments différents vis-à-vis du hub ; il faut donc trois
détecteurs. **Les trois posent exactement la même question avant tout verdict** (la règle du §3).

| détecteur | déclencheur | latence | couvre le cas |
|---|---|---|---|
| `#reapIfExited` | événement : le WS du channel se ferme | immédiate | mort « normale » — la stdio meurt avec le process, le WS tombe |
| `reconcileLiveness`, boucle `pipes` | poll superviseur `GET /sessions`, ~3 s | ≤ 3 s | mort **sans** fermeture du WS — claude wedgé garde sa stdio ouverte (l'incident stale-green, ADR 0008) |
| `reconcileLiveness`, boucle `pending` | même poll | ≤ 3 s | mort **avant** que le WS n'ait existé |

Détails d'exécution :

- `#reapIfExited` ne conclut jamais seul : il **confirme auprès du superviseur**. `running` →
  c'était un blip réseau, on ne touche à rien (le channel se reconnecte tout seul). `exited` ou
  `404` → mort avérée. Superviseur injoignable → on attend le prochain poll.
- Verdict côté superviseur : `exited` avec code ≠ 0 = crash → `error` ; code 0 = sortie propre
  → `dormant` ; `404` = session volontairement tuée et oubliée (reap idle, kill) → `dormant`.
- Note d'encodage : quand un WS tombe, le pipe est re-parqué en `pending` avec
  `resume := resume ∧ ¬replied` — dans une entrée `pending`, `resume` signifie donc déjà
  « pari non prouvé », et le détecteur n'y re-teste que `¬retriedFresh`. Même règle, encodée
  une étape plus tôt.

**Le plafond à un seul retry est structurel, pas compté** : le respawn de secours part
`forceFresh`, donc son `pending`/`pipe` porte `resume = false` et `retriedFresh = true` —
aucune des trois conditions de fallback ne peut plus jamais être vraie pour lui. S'il meurt
aussi, il suit le classement normal (`error`/`dormant`).

---

## 7. Tous les scénarios, déroulés

Chaque scénario = un chemin dans l'arbre du §3.

1. **Premier message d'une conversation neuve.** Pas d'ancre → départ à froid, aucun historique
   → push simple. À la première réponse, l'ancre naît. L'utilisateur voit : `starting` → `live`
   → réponse.

2. **Message sur une conversation déjà `live`.** Aucun spawn : push direct sur le pipe, réponse,
   l'ancre avance (`syncedSeq` = seq de la réponse). Chaque réponse remet aussi à zéro l'horloge
   idle du superviseur (`touch`).

3. **Réouverture nominale** (le runtime précédent a été reapé après 1 h d'idle). Ancre présente
   → pari `--resume`. Le transcript existe → claude recharge son contexte. Rien n'a été manqué
   (`syncedSeq` = dernier tour) → push simple du nouveau message. Réponse → `syncedSeq` avance.
   **Aucun seed : c'est tout l'intérêt de l'ADR 0007** (pas de replay, pas de troncature à 80
   tours, le raisonnement/outils natifs sont conservés).

4. **Réouverture avec tours manqués** (delta non vide). Même chemin que 3, mais des tours du hub
   ont un `seq > syncedSeq` sans faire partie du push courant → delta-seed (uniquement ces
   tours-là). Le calcul est local (§2) — exemple, le cas cible multi-harness :

   ```
   historique hub : m1 … m7 (kind claude) │ m8 … m12 (autre kind) │ m13 = nouveau message
   ancre claude   : { uuid, syncedSeq: 7 }        (figée pendant les tours de l'autre kind)
   delta          : seq > 7 hors push courant = m8 … m12
   push           : delta-seed(m8 … m12) + m13    (la session native connaît déjà m1 … m7)
   ```

   En mono-kind le delta est presque toujours vide : l'ancre avance à chaque réponse, donc
   `syncedSeq` colle au dernier tour d'assistant, et les messages arrivés depuis sont
   précisément le push courant — exclus du delta par construction. D'où le « push simple »
   du scénario 3 comme cas nominal.

   **Aujourd'hui ce chemin est du code dormant** : le registry n'a qu'un seul `kind`
   (`claude`) et `kind` n'est pas éditable (scénario 12) — le delta-seed ne peut pas se
   déclencher en prod avant l'arrivée d'un second harness. Il est couvert par les tests
   unitaires de `seed.js` ; pour l'observer en vrai, il faut simuler une ancre en retard
   (abaisser `syncedSeq` en base, puis rouvrir la conversation — log `delta-seeded …`).

5. **Réouverture, transcript disparu — le fallback** (bug trouvé et corrigé en C4, `e823795`).
   Pari `--resume` → channel s'attache (~40 ms), `ready` émis → claude découvre l'absence du
   transcript → exit 1 → WS tombe → `#reapIfExited` confirme la mort → règle du fallback vraie
   (`resume ∧ ¬replied ∧ ¬retriedFresh`) → ancre effacée, respawn `forceFresh` → seed complet →
   réponse → **nouvelle** ancre. L'utilisateur voit : `starting` un peu plus long que d'habitude,
   puis la réponse. Jamais d'`error` affiché.
   *Avant le fix* : seul le cas « mort avant attache » était couvert ; un resume mort *après*
   l'attache surfaçait `error` avec l'ancre intacte → chaque nouvel essai repartait sur le même
   uuid mort, en boucle, pour toujours.

6. **Le retry meurt aussi** (double échec — le problème n'était pas le transcript). Le retry
   porte `retriedFresh = true` → pas de second fallback → `error` (code ≠ 0) ou `dormant`.
   L'ancre ayant été effacée en 5, le prochain message utilisateur repart à froid + seed complet.
   Le système reste réparable par un simple message — c'est le plancher ADR 0005.

7. **Redémarrage du hub** (re-claim). `reconcile()` au boot : pour chaque bail persisté
   (`conv.pipe`), interroge le superviseur — `running` → re-parqué en `pending` avec
   `fresh = false`, le channel du runtime re-hello tout seul en quelques secondes ; mort →
   `dormant`. Un re-claim n'est jamais re-seedé (le runtime a déjà son contexte) et est marqué
   `ready` immédiatement (la frame `ready` ne part qu'une fois par vie de process, au premier
   ListTools). L'ancre continue d'avancer aux réponses suivantes, même uuid. Vérifié en C4
   (`syncedSeq` 8→10 à travers un restart).

8. **Blip WebSocket** (le WS tombe, le runtime vit). Re-parqué en `pending` ; `#reapIfExited`
   interroge le superviseur → `running` → on ne touche à rien ; le channel se reconnecte
   (backoff ~1,5 s) et re-réclame avec le même token → push simple. Une conversation qui a déjà
   répondu ne peut pas re-déclencher le fallback ici (`resume ∧ ¬replied` est faux).

9. **Le spawn lui-même échoue** (`POST /sessions` en erreur : image, superviseur, etc.).
   Aucun process n'existe → `error` immédiat (`spawn_failed`), pas de fallback. Tout nouveau
   message utilisateur efface l'erreur et retente (décision 1 normale).

10. **Runtime vivant mais muet** (boucle d'agent plantée, push jamais répondu). Le channel
    relivre le push 3 fois à 9 s d'intervalle, puis envoie `unresponsive` (~36 s au total) →
    `error` persisté. Le hub **ne tue pas** (ADR 0008) ; le superviseur reapera ce runtime à
    l'idle (1 h sans réponse, car seul un `reply` fait `touch`). Si c'était un pari jamais
    prouvé, le fallback se déclenchera *à sa mort effective* (le reap), via les détecteurs.

11. **Arrêt volontaire** (close/delete d'une conv, ou reap idle du superviseur). Kill propre →
    la session disparaît (`404`) ou sort code 0 → `dormant`. Un `404`/code 0 n'est **jamais**
    traité comme une panne : « pas de code de sortie = mort voulue » (ADR 0008).

12. **Changement de `kind`** (multi-harness, futur) — et pourquoi **changer de modèle n'en est
    pas un**. Deux choses distinctes :

    - **Changer de modèle** (sonnet → opus → …) : `model` est éditable (`store.patch`), mais
      l'ancre est indexée par *kind*, pas par modèle → au prochain spawn, `--resume <même uuid>
      --model <nouveau>`. La même session native continue, contexte natif intact, delta vide →
      push simple. **« Pas de seed » ne veut pas dire gratuit** : le prompt-cache est keyé par
      modèle, donc changer de modèle invalide le cache *quoi qu'on fasse* — le premier tour du
      nouveau modèle reprocesse tout le contexte à froid. Un re-seed n'y changerait rien (cache
      froid à l'identique) et *perdrait* de la fidélité (replay plat, tronqué à 80 tours) : à
      coût de cold-start égal, le resume conserve tout. C'est l'arbitrage de Claude Code
      lui-même, qui au `/model` mi-session continue la conversation telle quelle (et `opusplan`
      alterne deux modèles dans une même session) — le warning qu'il affiche signale le coût
      cache, pas une nécessité de repartir de zéro.

      **Effet immédiat (2026-07-04, amendement ADR 0008)** : le patch d'un paramètre de spawn
      (`model`/`effort`/`agent`) sur une conversation qui a un runtime **tue ce runtime**
      (commande produit, même catégorie que delete) : la conversation redevient `dormant`, et le
      tour suivant respawn `--resume <même uuid> --model <nouveau>`. Un tour resté sans réponse
      au moment du patch déclenche un respawn immédiat (rien d'autre ne respawnerait pour lui),
      pour être servi par les nouveaux paramètres ; un tour en cours de traitement est
      volontairement abandonné — changer de modèle en pleine réponse veut dire qu'on veut la
      réponse du nouveau. Le cold-start qui suit est le coût intrinsèque du switch (cache keyé
      par modèle), pas un coût du kill. `title`/`pinned` ne tuent jamais rien.

      **`resolvedModel` est une vérité par message, pas par conversation** : une session ne court
      qu'un seul modèle de toute sa vie (le kill-au-patch le garantit), donc chaque message
      assistant est estampillé à la réponse avec le modèle résolu de la session qui l'a produit
      (`message.resolvedModel` ; `NULL` = inconnu, tours pré-feature). `conv.resolvedModel` reste
      le « courant » (sidebar) ; les segments par modèle se dérivent à l'affichage en groupant
      les messages consécutifs de même valeur. Deux gardes rendent l'estampille fiable, toutes
      deux attrapées par le verrou prod du 2026-07-04 : côté superviseur, la lecture du modèle
      ignore tout ce qui précède le spawn (`transcriptBase` — un transcript *resumé* porte les
      tours, donc le modèle, du runtime précédent) ; côté hub, une réponse arrivée avant que la
      ligne du tour ne soit sur disque (claude écrit en fin de tour, après le tool `reply`) part
      sans estampille et est complétée au poll suivant — backfill du dernier message assistant,
      correct car une conversation n'a qu'un runtime à la fois. Verrou complet : sonnet → patch
      opus → resume → messages estampillés `claude-sonnet-5` puis `claude-opus-4-8`, même ancre
      de bout en bout.

      **Vérifié en prod le 2026-07-04** (pod agent-runtime, claude 2.1.197 épinglé) : tour 1
      `claude -p … --session-id U --model sonnet`, tour 2 `claude -p … --resume U --model opus`
      → rappel du codeword correct, un seul fichier `U.jsonl` (pas de fork), lignes assistant
      `claude-sonnet-5` puis `claude-opus-4-8` dans le même transcript — ce que `resolvedModel`
      remontera fidèlement.

    - **Changer de kind** (claude → autre harness) : le seul cas qui crée une seconde ancre.
      Aujourd'hui impossible : `kind` est fixé à la création (pas dans la whitelist de
      `store.patch`) et le registry n'a qu'un kind. Quand un second harness existera : aller =
      le nouveau kind n'a pas d'ancre → seed complet (« cross-seed = ancre 0 », ADR 0007) ;
      retour = `--resume` sur l'ancre du premier kind + delta-seed des tours faits entre-temps
      (cf. 4). Chaque kind rattrape ainsi ce qui s'est dit pendant qu'il était figé.

---

## 8. Ce que l'interface affiche (`stateOf`)

| état | condition (première vraie, dans cet ordre) |
|---|---|
| `error` | `conv.error` persisté en base — survit à un restart du hub. Posé par : `spawn_failed`, exit code ≠ 0, `unresponsive`. Effacé par : nouveau message utilisateur, nouveau spawn, `ready`, réponse. |
| `live` | pipe connecté **et** `ready` (ListTools vu, ou re-claim) |
| `starting` | `pending` (runtime lancé, channel pas là), ou pipe connecté pas encore `ready` |
| `dormant` | rien en RAM pour cette conversation |

Un fallback (scénario 5) ne passe jamais par `error` : chaque respawn efface l'erreur, l'utilisateur
ne voit qu'un `starting` prolongé.

---

## 9. Les invariants

1. **L'historique du hub est la seule vérité ; la session native n'est qu'un cache de contexte.**
   Perdre un transcript ne perd jamais de données — au pire une réponse plus lente (re-seed).
2. **Une ancre n'est écrite qu'à la réponse, jamais au spawn.** Un runtime mort-né ne pollue
   rien : l'ancienne ancre reste en place tant qu'une nouvelle n'a pas répondu.
3. **Au plus un retry automatique, garanti par construction** (le retry est inéligible au
   fallback par ses propres drapeaux), pas par un compteur.
4. **Le hub ne tue jamais un runtime** (ADR 0008) — il constate des morts (crash, reap idle du
   superviseur, kill explicite de close/delete) et les classe.

---

## 10. L'hypothèse unique, et ses garde-fous

Tout le §5 repose sur un comportement de claude vérifié (C0, C4, claude 2.1.197) :
**`--resume` vers un transcript absent fait *sortir* le process (« No conversation found », exit 1)
sans jamais répondre.** Si une future version répondait *silencieusement à froid* à la place :
la réponse serait appauvrie (contexte perdu) et `replied = true` conserverait l'ancre.

Garde-fous : la version de claude est épinglée dans l'image (`DISABLE_AUTOUPDATER=1` +
`autoUpdates: false` — une montée de version est un choix, testé) ; et même dans ce cas
l'historique du hub resterait intact — une mauvaise *réponse* est possible, un état faux
permanent ne l'est pas.

**L'hypothèse est par harness.** La machinerie du hub (ancre par kind, verdict à la réponse,
fallback, delta) ne contient rien de spécifique à claude ; mais activer le *resume* pour un
futur kind exige de vérifier son **contrat**, par un verify-gate équivalent à C0 :

1. une session reprennable par identifiant (équivalent `--resume`) ;
2. un identifiant imposable au spawn (équivalent `--session-id`) — ou à défaut récupérable de
   façon fiable, la recette `spawnSpec` de ce kind s'en chargeant ;
3. un resume raté qui **échoue bruyamment** (exit) au lieu de démarrer silencieusement à vide —
   l'hypothèse ci-dessus, celle qui porte tout le verdict ;
4. pour la propriété « switch de modèle sans re-seed » (scénario 12) : le changement de modèle
   intra-session accepté.

Un harness qui ne remplit pas ce contrat n'active simplement pas `resumeFrom` dans sa recette :
aucune ancre n'est jamais utilisée pour ce kind → chaque réouverture = seed complet, le plancher
ADR 0005. **Le resume est un accélérateur opt-in par kind, jamais une dépendance** — un harness
non conforme dégrade, il ne casse pas.

---

## Annexe — où c'est dans le code

| concept | code |
|---|---|
| Décision 1 (ancre → `--resume`/`--session-id`) | `website/lib/hub.js` `#spawnFor` ; flags CLI dans `website/lib/supervisor.js` `spawnSpec` |
| Décision 2 (seed complet / delta / push) | `hub.js` `#deliverBacklog` ; builders dans `website/lib/seed.js` (`buildSeedContent`, `computeDelta`, `buildDeltaSeedContent`) |
| Succès (écriture de l'ancre + estampille `resolvedModel` du message) | `hub.js` `onChannelReply` → `store.setNativeHandle`, `store.addMessage` |
| Kill-au-patch (changement `model`/`effort`/`agent`) | `hub.js` `patchConversation` → `closeConversation` (+ respawn si tour sans réponse) |
| Détecteurs de mort | `hub.js` `#reapIfExited`, `reconcileLiveness` (boucles `pipes` puis `pending`) |
| Fallback | `hub.js` `#fallbackToFreshResume` |
| États | `hub.js` `stateOf` |
| Relivraison + `unresponsive` (3×9 s) | `channel/server.js` (`ACK_RETRY_MS`, `ACK_MAX_TRIES`) |
| Reap idle (1 h, `touch` sur réponse) | superviseur agent-runtime ; TTL passé par `spawnSpec` (`cacheTtlFor`) |

// Contenus d'exemple, réalistes pour Agora, réutilisés par la démo et la galerie.
import {
  NOTICE_TEXT,
  PERMISSION_OPTIONS,
  type Element,
  type Notice,
  type NoticeCode,
  type PlanEntry,
  type ToolElement,
  type Turn,
  type TurnState,
} from "./model";

let seq = 0;
export const uid = (prefix: string) => `${prefix}-${++seq}`;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

export const notice = (code: NoticeCode, text = NOTICE_TEXT[code]): Notice => ({
  kind: "notice",
  id: uid("notice"),
  createdAt: minutesAgo(30),
  code,
  text,
});

export const turn = (
  prompt: string,
  state: TurnState,
  elements: Element[] = [],
  extra: Partial<Turn> = {},
): Turn => ({
  kind: "turn",
  id: uid("turn"),
  createdAt: minutesAgo(20),
  prompt,
  state,
  elements,
  ...extra,
});

export const text = (t: string): Element => ({ kind: "text", id: uid("text"), text: t });
export const reasoning = (t: string): Element => ({ kind: "reasoning", id: uid("reasoning"), text: t });
export const plan = (entries: PlanEntry[]): Element => ({ kind: "plan", id: uid("plan"), entries });
export const tool = (t: Omit<ToolElement, "kind" | "id" | "toolCallId">): ToolElement => ({
  kind: "tool",
  id: uid("tool"),
  toolCallId: uid("call"),
  ...t,
});

export const permission = (answer?: string) => ({
  requestId: uid("perm"),
  options: PERMISSION_OPTIONS,
  answer,
});

/* ---------- Contenus ---------- */

export const PROMPT = "Ajoute `session_id` à la projection et lance les tests.";

export const REASONING =
  "La projection lit `acp_frames` et regroupe par tour. Il faut propager `session_id` depuis la trame `session/new` : le plus simple est une jointure sur la table des sessions, puis vérifier que les tests de projection couvrent le changement de session en plein workstream.";

export const OLD_SQL = `create view turn_projection as
select t.id,
       t.workstream_id,
       string_agg(f.payload->>'text', '' order by f.seq) as text
from turns t
join acp_frames f on f.turn_id = t.id
group by t.id, t.workstream_id;
`;

export const NEW_SQL = `create view turn_projection as
select t.id,
       t.workstream_id,
       s.id as session_id,
       string_agg(f.payload->>'text', '' order by f.seq) as text
from turns t
join sessions s on s.id = t.session_id
join acp_frames f on f.turn_id = t.id
group by t.id, t.workstream_id, s.id;
`;

export const TEST_LINES = [
  "> agora@0.0.0 test",
  "> node --test dist/test/**/*.test.js",
  "",
  "▶ turn_projection",
  "  ✔ concatène les fragments dans l'ordre (12ms)",
  "  ✔ expose session_id pour chaque tour (8ms)",
  "  ✔ change de session en plein workstream (15ms)",
  "▶ turn_projection (41ms)",
  "ℹ tests 3",
  "ℹ pass 3",
  "ℹ fail 0",
];

export const ANSWER = `C'est fait. La vue \`turn_projection\` expose maintenant \`session_id\` :

- jointure sur \`sessions\` à partir de \`turns.session_id\` ;
- la colonne est ajoutée au \`group by\` ;
- les trois tests de projection passent, dont le **changement de session** en plein workstream.

| Colonne | Source |
| --- | --- |
| \`id\` | \`turns.id\` |
| \`session_id\` | \`sessions.id\` |
| \`text\` | fragments \`agent_message_chunk\` |

> La vue reste une vue simple : pas de rafraîchissement à prévoir.`;

export const PLAN_DONE: PlanEntry[] = [
  { content: "Lire la projection actuelle", status: "completed", priority: "high" },
  { content: "Ajouter session_id à la vue", status: "completed", priority: "high" },
  { content: "Lancer les tests de projection", status: "completed", priority: "medium" },
];

export const readTool = (status: ToolElement["status"] = "completed") =>
  tool({
    title: "Lire contracts/db/projection.sql",
    toolKind: "read",
    status,
    input: { path: "contracts/db/projection.sql" },
    output: status === "completed" ? OLD_SQL : undefined,
    locations: ["contracts/db/projection.sql"],
  });

/** `answer: null` = permission encore en attente. */
export const editTool = (status: ToolElement["status"] = "completed", answer: string | null = "allow-once") =>
  tool({
    title: "Modifier contracts/db/projection.sql",
    toolKind: "edit",
    status,
    input: { path: "contracts/db/projection.sql" },
    diff: { path: "contracts/db/projection.sql", oldText: OLD_SQL, newText: NEW_SQL },
    output: status === "completed" ? "Fichier modifié." : status === "failed" ? "Refusé par l'utilisateur." : undefined,
    permission: permission(answer ?? undefined),
  });

export const testTool = (status: ToolElement["status"] = "completed", lines = TEST_LINES) =>
  tool({
    title: "npm test -w @agora/journal",
    toolKind: "execute",
    status,
    input: { command: "npm test -w @agora/journal" },
    terminal: { command: "npm test -w @agora/journal", lines },
    output: status === "completed" ? lines.join("\n") : undefined,
  });

/** Un tour complet qui utilise tous les éléments. */
export const fullTurn = (): Turn =>
  turn(PROMPT, "completed", [
    reasoning(REASONING),
    plan(PLAN_DONE),
    readTool(),
    editTool(),
    testTool(),
    text(ANSWER),
  ], { stopReason: "end_turn" });

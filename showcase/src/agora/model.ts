// Le fil tel qu'Agora l'envoie (assistant-ui.md) : workstreams, tours, éléments, avis.
// Ce banc d'essai le fabrique en mémoire ; le vrai serveur le projette depuis le journal ACP.

export type Execution = "starting" | "available" | "error" | "stopped";

export type Workstream = {
  id: string;
  title: string;
  harness: string;
  execution: Execution;
  /** Envois fermés pour une autre raison que l'exécution (stockage indisponible…). */
  sendsClosed?: string;
  lastActivity?: Date;
};

export type TurnState =
  | "recorded"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "uncertain";

/** Sortes d'outil ACP. */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export type PermissionKind =
  | "allow-once"
  | "allow-always"
  | "reject-once"
  | "reject-always";

export type Permission = {
  requestId: string;
  options: { optionId: string; name: string; kind: PermissionKind }[];
  /** optionId choisi, ou « cancelled » quand le tour a été annulé. */
  answer?: string;
};

export type ToolElement = {
  kind: "tool";
  id: string;
  toolCallId: string;
  title: string;
  toolKind: ToolKind;
  status: "pending" | "in_progress" | "completed" | "failed";
  input?: Record<string, unknown>;
  output?: string;
  diff?: { path: string; oldText: string; newText: string };
  terminal?: { command: string; lines: string[] };
  locations?: string[];
  permission?: Permission;
};

export type PlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
};

export type Element =
  | { kind: "text"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string }
  | ToolElement
  | { kind: "plan"; id: string; entries: PlanEntry[] };

export type Turn = {
  kind: "turn";
  id: string;
  createdAt: Date;
  prompt: string;
  state: TurnState;
  stopReason?: string;
  error?: string;
  uncertainty?: string;
  elements: Element[];
};

export type NoticeCode =
  | "session-started"
  | "session-ended"
  | "context-lost"
  | "harness-lost";

export type Notice = {
  kind: "notice";
  id: string;
  createdAt: Date;
  code: NoticeCode;
  text: string;
};

export type ThreadItem = Turn | Notice;

export const NOTICE_TEXT: Record<NoticeCode, string> = {
  "session-started": "Session démarrée — claude-code 2.1, modèle Opus.",
  "session-ended": "Session terminée — l'exécution a été arrêtée.",
  "context-lost":
    "Contexte perdu — le nouveau harness ne connaît pas l'historique ci-dessus.",
  "harness-lost":
    "Harness perdu — le sandbox a disparu pendant le tour. L'historique est conservé.",
};

export const EXECUTION_LABEL: Record<Execution, string> = {
  starting: "démarrage",
  available: "disponible",
  error: "erreur",
  stopped: "arrêtée",
};

export const TURN_LABEL: Record<TurnState, string> = {
  recorded: "enregistré",
  running: "en cours",
  completed: "terminé",
  cancelled: "annulé",
  failed: "échoué",
  uncertain: "incertain",
};

export const PERMISSION_OPTIONS: Permission["options"] = [
  { optionId: "allow-once", name: "Autoriser une fois", kind: "allow-once" },
  { optionId: "allow-always", name: "Toujours autoriser", kind: "allow-always" },
  { optionId: "reject-once", name: "Refuser", kind: "reject-once" },
  { optionId: "reject-always", name: "Toujours refuser", kind: "reject-always" },
];

export const isOpenTurn = (item: ThreadItem | undefined) =>
  item?.kind === "turn" && (item.state === "recorded" || item.state === "running");

export const lastTurn = (items: readonly ThreadItem[]): Turn | undefined =>
  [...items].reverse().find((i): i is Turn => i.kind === "turn");

/** Pourquoi les envois sont fermés, ou undefined s'ils sont ouverts. */
export const sendsClosedReason = (ws: Workstream): string | undefined => {
  if (ws.execution === "starting") return "L'exécution démarre : l'envoi ouvrira quand ACP répondra.";
  if (ws.execution === "error") return "L'exécution est en erreur : aucun envoi possible.";
  if (ws.execution === "stopped") return "Workstream arrêté : le fil reste lisible.";
  return ws.sendsClosed;
};

// La correspondance du contrat : un tour → un message user + un message assistant,
// un avis → un message system, un élément → une part.
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { Element, ThreadItem, ToolElement, Turn } from "./model";

type Part = Exclude<ThreadMessageLike["content"], string>[number];

const ALLOW = new Set(["allow-once", "allow-always"]);

const toolPart = (el: ToolElement): Part => {
  const terminal = el.status === "completed" || el.status === "failed";
  const p = el.permission;
  const chosen = p?.options.find((o) => o.optionId === p.answer);
  return {
    type: "tool-call",
    toolCallId: el.toolCallId,
    toolName: el.toolKind,
    args: (el.input ?? {}) as never,
    argsText: el.input ? JSON.stringify(el.input, null, 2) : "",
    // Un outil clos porte toujours un résultat, sinon assistant-ui le croit en cours.
    result: terminal ? (el.output ?? "(aucune sortie)") : undefined,
    isError: el.status === "failed",
    artifact: {
      title: el.title,
      locations: el.locations,
      diff: el.diff,
      terminal: el.terminal,
      acpStatus: el.status,
    },
    ...(p && {
      approval: {
        id: p.requestId,
        prompt: el.title,
        options: p.options.map((o) => ({ id: o.optionId, kind: o.kind, label: o.name })),
        ...(p.answer === "cancelled"
          ? { resolution: "cancelled" as const }
          : chosen
            ? { approved: ALLOW.has(chosen.kind), optionId: chosen.optionId }
            : {}),
      },
    }),
  };
};

const part = (el: Element): Part => {
  switch (el.kind) {
    case "text":
      return { type: "text", text: el.text };
    case "reasoning":
      return { type: "reasoning", text: el.text };
    case "tool":
      return toolPart(el);
    case "plan":
      return { type: "data", name: "plan", data: { entries: el.entries } };
  }
};

const pendingPermission = (turn: Turn) =>
  turn.elements.some(
    (e) => e.kind === "tool" && e.permission && e.permission.answer === undefined,
  );

const assistantStatus = (turn: Turn): ThreadMessageLike["status"] => {
  switch (turn.state) {
    case "recorded":
      return { type: "running" };
    case "running":
      // Une permission en attente met la réponse en « requires-action » :
      // c'est ce qui fait apparaître les boutons dans ToolFallback.
      return pendingPermission(turn)
        ? { type: "requires-action", reason: "tool-calls" }
        : { type: "running" };
    case "completed":
      return { type: "complete", reason: "stop" };
    case "cancelled":
      return { type: "incomplete", reason: "cancelled" };
    case "failed":
      return { type: "incomplete", reason: "error", error: turn.error ?? "Erreur" };
    case "uncertain":
      return { type: "incomplete", reason: "other" };
  }
};

export const toMessages = (item: ThreadItem): ThreadMessageLike[] => {
  if (item.kind === "notice") {
    return [
      {
        id: item.id,
        role: "system",
        createdAt: item.createdAt,
        content: [{ type: "text", text: item.text }],
        metadata: { custom: { notice: item.code } },
      },
    ];
  }
  const custom = { turnState: item.state, uncertainty: item.uncertainty, stopReason: item.stopReason };
  return [
    {
      id: `${item.id}:u`,
      role: "user",
      createdAt: item.createdAt,
      content: [{ type: "text", text: item.prompt }],
      metadata: { custom },
    },
    {
      id: `${item.id}:a`,
      role: "assistant",
      createdAt: item.createdAt,
      content: item.elements.map(part),
      status: assistantStatus(item),
      metadata: { custom },
    },
  ];
};

// Rendus par sorte d'outil ACP et rendu du plan.
// L'aiguillage passe par l'emplacement `ToolFallback` du Thread : makeAssistantToolUI
// est déprécié en 0.15.
import { makeAssistantDataUI, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";
import { TodoList, type TodoItem } from "@/components/assistant-ui/elements/todo-list";
import { DiffViewer } from "@/components/ui/diff-viewer";
import type { PlanEntry, ToolElement } from "./model";

type Artifact = {
  title?: string;
  diff?: ToolElement["diff"];
  terminal?: ToolElement["terminal"];
  acpStatus?: ToolElement["status"];
};

/** Diff et terminal gardent le cadre de ToolFallback : titre, erreur, permission. */
const FramedTool: ToolCallMessagePartComponent = (props) => {
  const artifact = (props.artifact ?? {}) as Artifact;
  const title = artifact.title ?? props.toolName;
  const needsAnswer = props.status?.type === "requires-action";
  return (
    <ToolFallback.Root defaultOpen>
      <ToolFallback.Trigger toolName={title} status={props.status} />
      <ToolFallback.Content>
        <ToolFallback.Error status={props.status} />
        {artifact.diff && (
          <div className="px-4 pb-2">
            <DiffViewer
              oldFile={{ content: artifact.diff.oldText, name: artifact.diff.path }}
              newFile={{ content: artifact.diff.newText, name: artifact.diff.path }}
              size="sm"
            />
          </div>
        )}
        {artifact.terminal && (
          <div className="px-4 pb-2">
            <TerminalBlock
              command={artifact.terminal.command}
              lines={artifact.terminal.lines}
              visibleCount={artifact.terminal.lines.length}
              done={props.result !== undefined}
              variant="ink"
            />
          </div>
        )}
        {needsAnswer && (
          <ToolFallback.Approval
            approval={props.approval}
            respondToApproval={props.respondToApproval}
            addResult={props.addResult}
            resume={props.resume}
            interrupt={props.interrupt}
            status={props.status}
          />
        )}
        <ToolFallback.ApprovalOutcome approval={props.approval} />
      </ToolFallback.Content>
    </ToolFallback.Root>
  );
};

export const AgoraTool: ToolCallMessagePartComponent = (props) => {
  const artifact = (props.artifact ?? {}) as Artifact;
  if ((props.toolName === "edit" && artifact.diff) || (props.toolName === "execute" && artifact.terminal)) {
    return <FramedTool {...props} />;
  }
  return <ToolFallback {...props} />;
};

const TODO_STATUS: Record<PlanEntry["status"], TodoItem["status"]> = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
};

export const planItems = (entries: PlanEntry[]): TodoItem[] =>
  entries.map((e, i) => ({ id: String(i), text: e.content, status: TODO_STATUS[e.status] }));

const PlanUI = makeAssistantDataUI<{ entries: PlanEntry[] }>({
  name: "plan",
  render: ({ data }) => (
    <div className="my-3">
      <TodoList items={planItems(data.entries)} />
    </div>
  ),
});

export function AgoraToolkit() {
  return <PlanUI />;
}

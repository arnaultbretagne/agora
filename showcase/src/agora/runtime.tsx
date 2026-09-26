// Le pont du contrat : useExternalStoreRuntime alimenté par le fil Agora.
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { toMessages } from "./convert";
import { AgoraToolkit } from "./toolkit";
import {
  isOpenTurn,
  lastTurn,
  sendsClosedReason,
  type ThreadItem,
  type Workstream,
} from "./model";

export type AgoraCommands = {
  write?: (text: string) => void;
  cancel?: (turnId: string) => void;
  answerPermission?: (requestId: string, optionId: string) => void;
};

export type AgoraThreadList = {
  workstreams: Workstream[];
  currentId: string;
  open: (id: string) => void;
  create: () => void;
  loading?: boolean;
};

/** Ce que les composants « à nous » lisent : état de l'exécution et fermeture des envois. */
export const WorkstreamContext = createContext<Workstream | null>(null);
export const useWorkstream = () => useContext(WorkstreamContext);

export function AgoraProvider({
  workstream,
  items,
  commands = {},
  threadList,
  children,
}: {
  workstream: Workstream;
  items: readonly ThreadItem[];
  commands?: AgoraCommands;
  threadList?: AgoraThreadList;
  children: ReactNode;
}) {
  const messages = useMemo(() => items.flatMap(toMessages), [items]);
  const closed = sendsClosedReason(workstream);

  const threadListAdapter: ExternalStoreThreadListAdapter | undefined = threadList && {
    threadId: threadList.currentId,
    isLoading: threadList.loading,
    threads: threadList.workstreams.map((ws) => ({
      id: ws.id,
      status: "regular" as const,
      title: ws.title,
      custom: { execution: ws.execution, harness: ws.harness },
    })),
    onSwitchToThread: threadList.open,
    onSwitchToNewThread: threadList.create,
  };

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (m) => m,
    isRunning: isOpenTurn(items[items.length - 1]),
    isSendDisabled: closed !== undefined,
    isDisabled: workstream.execution === "stopped",
    onNew: async (message) => {
      const text = message.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("");
      commands.write?.(text);
    },
    onCancel: async () => {
      const turn = lastTurn(items);
      if (turn) commands.cancel?.(turn.id);
    },
    onRespondToToolApproval: async ({ approvalId, optionId, approved }) => {
      commands.answerPermission?.(
        approvalId,
        optionId ?? (approved ? "allow-once" : "reject-once"),
      );
    },
    adapters: threadListAdapter ? { threadList: threadListAdapter } : undefined,
  });

  return (
    <WorkstreamContext.Provider value={workstream}>
      <AssistantRuntimeProvider runtime={runtime}>
        <AgoraToolkit />
        {children}
      </AssistantRuntimeProvider>
    </WorkstreamContext.Provider>
  );
}

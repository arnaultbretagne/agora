import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useState, type CSSProperties, type ReactNode } from "react";
import {
  ThreadComponentsContext,
  ThreadMessage,
  type ThreadComponents,
} from "@/components/assistant-ui/elements/thread.aui";
import { AgoraProvider } from "@/agora/runtime";
import type { ThreadItem, Workstream } from "@/agora/model";
import { cn } from "@/lib/utils";

export const THREAD_VARS = {
  "--thread-max-width": "44rem",
  "--composer-bg": "color-mix(in oklab, var(--color-muted) 30%, transparent)",
  "--composer-radius": "1rem",
  "--composer-padding": "8px",
} as CSSProperties;

export const WS: Workstream = {
  id: "ws-preview",
  title: "Aperçu",
  harness: "claude-code",
  execution: "available",
};

export function Section({
  id,
  title,
  lead,
  binding,
  children,
}: {
  id: string;
  title: string;
  lead?: ReactNode;
  binding?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 border-b py-12 last:border-b-0">
      <h2 className="font-heading text-3xl tracking-tight">{title}</h2>
      {lead && <p className="text-muted-foreground mt-2 max-w-3xl text-[15px] leading-relaxed">{lead}</p>}
      {binding && (
        <p className="text-muted-foreground mt-3 max-w-3xl text-xs leading-relaxed">
          <span className="text-primary font-medium">Branchement · </span>
          {binding}
        </p>
      )}
      <div className="mt-8 flex flex-col gap-10">{children}</div>
    </section>
  );
}

export function Group({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-foreground text-base font-semibold">{title}</h3>
      {note && <p className="text-muted-foreground mt-1 max-w-3xl text-sm">{note}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function Grid({ cols = 2, children }: { cols?: 1 | 2 | 3 | 4; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid gap-4",
        cols === 2 && "lg:grid-cols-2",
        cols === 3 && "md:grid-cols-2 xl:grid-cols-3",
        cols === 4 && "md:grid-cols-2 xl:grid-cols-4",
      )}
    >
      {children}
    </div>
  );
}

/** Une option ou un état, avec son étiquette. */
export function Variant({
  label,
  code,
  note,
  className,
  children,
}: {
  label: string;
  code?: string;
  note?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className="bg-background flex min-w-0 flex-col rounded-xl border">
      <figcaption className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b px-4 py-2.5">
        <span className="text-sm font-medium">{label}</span>
        {code && <code className="text-muted-foreground font-mono text-[11px]">{code}</code>}
        {note && <span className="text-muted-foreground w-full text-xs">{note}</span>}
      </figcaption>
      <div className={cn("min-w-0 flex-1 p-4", className)}>{children}</div>
    </figure>
  );
}

/** Le fil rendu par le vrai Thread adapté, sans composer, avec un faux serveur local. */
export function MessagesPreview({
  items: initial,
  workstream = WS,
  components = {},
}: {
  items: ThreadItem[];
  workstream?: Workstream;
  components?: ThreadComponents;
}) {
  const [items, setItems] = useState(initial);
  return (
    <AgoraProvider
      workstream={workstream}
      items={items}
      commands={{
        answerPermission: (requestId, optionId) =>
          setItems((all) =>
            all.map((i) =>
              i.kind !== "turn"
                ? i
                : {
                    ...i,
                    elements: i.elements.map((e) =>
                      e.kind === "tool" && e.permission?.requestId === requestId
                        ? { ...e, permission: { ...e.permission, answer: optionId } }
                        : e,
                    ),
                  },
            ),
          ),
      }}
    >
      <ThreadComponentsContext.Provider value={components}>
        <ThreadPrimitive.Root className="aui-root" style={THREAD_VARS}>
          <div className="flex flex-col gap-y-6">
            <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
          </div>
        </ThreadPrimitive.Root>
      </ThreadComponentsContext.Provider>
    </AgoraProvider>
  );
}

/** Des messages assistant-ui bruts, pour montrer des options que le contrat n'utilise pas encore. */
export function RawPreview({
  messages: initial,
  children,
}: {
  messages: ThreadMessageLike[];
  children?: ReactNode;
}) {
  const [messages, setMessages] = useState(initial);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (m) => m,
    onNew: async () => {},
    onRespondToToolApproval: async ({ approvalId, approved, optionId, text }) =>
      setMessages((all) =>
        all.map((m) =>
          typeof m.content === "string"
            ? m
            : {
                ...m,
                content: m.content.map((p) =>
                  p.type === "tool-call" && p.approval?.id === approvalId
                    ? { ...p, approval: { ...p.approval, approved, optionId, text } }
                    : p,
                ),
              },
        ),
      ),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="aui-root" style={THREAD_VARS}>
        <div className="flex flex-col gap-y-6">
          {children ?? <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>}
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

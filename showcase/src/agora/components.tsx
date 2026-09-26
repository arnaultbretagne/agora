// Les composants « à nous » du contrat : avis, badge d'état du tour, bandeaux,
// choix du harness, badge d'exécution.
import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import {
  AlertTriangleIcon,
  CircleOffIcon,
  ClockIcon,
  LoaderIcon,
  LockIcon,
  PlayIcon,
  PowerIcon,
  UnplugIcon,
  XCircleIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  EXECUTION_LABEL,
  sendsClosedReason,
  type Execution,
  type NoticeCode,
  type TurnState,
} from "./model";
import { useWorkstream } from "./runtime";

/* ---------- Avis ---------- */

const NOTICE_STYLE: Record<NoticeCode, { icon: ReactNode; tone: string }> = {
  "session-started": { icon: <PlayIcon className="size-3.5" />, tone: "text-teal" },
  "session-ended": { icon: <PowerIcon className="size-3.5" />, tone: "text-muted-foreground" },
  "context-lost": { icon: <CircleOffIcon className="size-3.5" />, tone: "text-amber" },
  "harness-lost": { icon: <UnplugIcon className="size-3.5" />, tone: "text-destructive" },
};

export function NoticeView({ code, text }: { code: NoticeCode; text: string }) {
  const style = NOTICE_STYLE[code];
  return (
    <div className="flex items-center gap-3 px-2 py-1 text-xs" role="note">
      <span className="bg-border h-px flex-1" />
      <span className={cn("flex max-w-[80%] items-center gap-1.5 text-center", style.tone)}>
        {style.icon}
        <span className="text-muted-foreground">{text}</span>
      </span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

/** Un message `system` du fil. */
export function NoticeMessage() {
  const code = useAuiState((s) => s.message.metadata.custom.notice) as NoticeCode;
  const text = useAuiState((s) => {
    const first = s.message.parts[0];
    return first?.type === "text" ? first.text : "";
  });
  return (
    <MessagePrimitive.Root data-role="system">
      <NoticeView code={code} text={text} />
    </MessagePrimitive.Root>
  );
}

/* ---------- État du tour ---------- */

export function TurnBadgeView({ state }: { state: TurnState | undefined }) {
  if (state === "recorded")
    return (
      <Badge variant="outline" className="text-muted-foreground gap-1 font-normal">
        <ClockIcon /> enregistré
      </Badge>
    );
  if (state === "uncertain")
    return (
      <Badge className="bg-amber/15 text-amber border-amber/40 gap-1 border">
        <AlertTriangleIcon /> livraison incertaine
      </Badge>
    );
  return null;
}

/** Sous le message utilisateur. */
export function TurnBadge() {
  const state = useAuiState((s) => s.message.metadata.custom.turnState) as TurnState | undefined;
  const badge = <TurnBadgeView state={state} />;
  if (state !== "recorded" && state !== "uncertain") return null;
  return <div className="col-start-2 flex justify-end">{badge}</div>;
}

export function UncertainCalloutView({ detail }: { detail?: string }) {
  return (
    <div className="border-amber/40 bg-amber/10 mt-2 rounded-md border p-3 text-sm">
      <p className="text-foreground flex items-center gap-1.5 font-medium">
        <AlertTriangleIcon className="text-amber size-4" /> Tour incertain
      </p>
      <p className="text-muted-foreground mt-1">
        {detail ??
          "La connexion ACP a été perdue pendant le tour. Agora ne sait pas ce que l'agent a reçu ni fait, et n'a rien renvoyé."}
      </p>
    </div>
  );
}

/** Dans la réponse de l'agent, pour un tour incertain ou annulé. */
export function TurnOutcome() {
  const state = useAuiState((s) => s.message.metadata.custom.turnState) as TurnState | undefined;
  const detail = useAuiState((s) => s.message.metadata.custom.uncertainty) as string | undefined;
  if (state === "uncertain") return <UncertainCalloutView detail={detail} />;
  if (state === "cancelled")
    return (
      <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
        <XCircleIcon className="size-3.5" /> Tour annulé à la demande de l'utilisateur.
      </p>
    );
  return null;
}

/* ---------- Bandeaux ---------- */

export function ExecutionBannerView({ execution, detail }: { execution: Execution; detail?: string }) {
  if (execution === "available") return null;
  const view = {
    starting: {
      icon: <LoaderIcon className="size-4 animate-spin" />,
      title: "Démarrage de l'exécution",
      body: detail ?? "Sandbox demandé à Agent Sandbox, en attente de la connexion ACP.",
      tone: "border-primary/30 bg-primary/5",
    },
    error: {
      icon: <XCircleIcon className="text-destructive size-4" />,
      title: "Exécution en erreur",
      body: detail ?? "Le sandbox n'a pas pu démarrer : le claim est resté sans Ready.",
      tone: "border-destructive/40 bg-destructive/5",
    },
    stopped: {
      icon: <PowerIcon className="text-muted-foreground size-4" />,
      title: "Workstream arrêté",
      body: detail ?? "L'exécution a été retirée. Le fil reste lisible.",
      tone: "border-border bg-muted/50",
    },
  }[execution];
  return (
    <div className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm", view.tone)}>
      <span className="mt-0.5">{view.icon}</span>
      <div>
        <p className="text-foreground font-medium">{view.title}</p>
        <p className="text-muted-foreground">{view.body}</p>
      </div>
    </div>
  );
}

export function ExecutionBanner() {
  const ws = useWorkstream();
  if (!ws) return null;
  return <ExecutionBannerView execution={ws.execution} />;
}

export function SendsClosedBannerView({ reason }: { reason?: string }) {
  if (!reason) return null;
  return (
    <div className="text-muted-foreground bg-muted/60 flex items-center gap-2 rounded-lg px-3 py-2 text-xs">
      <LockIcon className="size-3.5 shrink-0" />
      <span>{reason}</span>
    </div>
  );
}

export function SendsClosedBanner() {
  const ws = useWorkstream();
  if (!ws) return null;
  return <SendsClosedBannerView reason={sendsClosedReason(ws)} />;
}

/* ---------- Barre latérale ---------- */

const EXECUTION_DOT: Record<Execution, string> = {
  starting: "bg-primary animate-pulse",
  available: "bg-success",
  error: "bg-destructive",
  stopped: "bg-muted-foreground/50",
};

export function ExecutionBadgeView({ execution, compact }: { execution: Execution; compact?: boolean }) {
  return (
    <Badge variant="outline" className="text-muted-foreground gap-1.5 font-normal">
      <span className={cn("size-1.5 rounded-full", EXECUTION_DOT[execution])} />
      {!compact && EXECUTION_LABEL[execution]}
    </Badge>
  );
}

/** Dans un élément de la liste des workstreams. */
export function ExecutionBadge() {
  const execution = useAuiState(
    (s) => (s.threadListItem.custom as { execution?: Execution } | undefined)?.execution,
  );
  if (!execution) return null;
  return (
    <span className="ms-1.5 shrink-0" title={EXECUTION_LABEL[execution]}>
      <span className={cn("block size-1.5 rounded-full", EXECUTION_DOT[execution])} />
    </span>
  );
}

/* ---------- Choix du harness ---------- */

export const HARNESSES = [
  { id: "claude-code", name: "Claude Code", detail: "Anthropic · reprise native démontrée" },
  { id: "codex", name: "Codex", detail: "OpenAI · reprise après le premier message" },
  { id: "opencode", name: "OpenCode", detail: "Multi-fournisseurs · reprise non démontrée" },
];

export function HarnessPicker({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (harness: string) => void;
}) {
  const [choice, setChoice] = useState(HARNESSES[0].id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl">Nouveau workstream</DialogTitle>
          <DialogDescription>Choisir le harness parmi les options autorisées.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {HARNESSES.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => setChoice(h.id)}
              className={cn(
                "flex flex-col items-start rounded-lg border px-3 py-2 text-start transition-colors",
                choice === h.id ? "border-primary bg-primary/5" : "hover:bg-muted",
              )}
            >
              <span className="text-sm font-medium">{h.name}</span>
              <span className="text-muted-foreground text-xs">{h.detail}</span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            onClick={() => {
              onCreate(choice);
              onOpenChange(false);
            }}
          >
            Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

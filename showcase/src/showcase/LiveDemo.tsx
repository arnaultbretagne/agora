import { useState, type ReactNode } from "react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { HarnessPicker } from "@/agora/components";
import { fullTurn, notice, text, turn } from "@/agora/fixtures";
import { EXECUTION_LABEL, type Execution, type NoticeCode } from "@/agora/model";
import { AgoraProvider } from "@/agora/runtime";
import { useSimulator, type Outcome, type SimState } from "@/agora/simulator";
import { cn } from "@/lib/utils";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

const INITIAL: SimState = {
  currentId: "ws-projection",
  workstreams: [
    { id: "ws-projection", title: "Projection des tours", harness: "claude-code", execution: "available", lastActivity: new Date() },
    { id: "ws-review", title: "Revue des permissions", harness: "claude-code", execution: "starting", lastActivity: hoursAgo(1) },
    { id: "ws-opencode", title: "Essai OpenCode", harness: "opencode", execution: "error", lastActivity: hoursAgo(26) },
    { id: "ws-migration", title: "Migration du schéma", harness: "codex", execution: "stopped", lastActivity: hoursAgo(50) },
  ],
  items: {
    "ws-projection": [notice("session-started"), fullTurn()],
    "ws-review": [],
    "ws-opencode": [],
    "ws-migration": [
      notice("session-started", "Session démarrée — codex 0.52."),
      turn("Liste les tables qui n'ont pas de clé primaire.", "completed", [
        text("Deux tables : `acp_frames_archive` et `import_log`. Les autres ont toutes une clé primaire."),
      ]),
      turn(
        "Ajoute une clé primaire à `import_log` et migre les données.",
        "uncertain",
        [text("Je crée la colonne `id` puis je")],
        { uncertainty: "Le sandbox a disparu pendant le tour. La migration a peut-être commencé : vérifier `import_log` avant de relancer." },
      ),
      notice("harness-lost"),
      notice("session-ended"),
    ],
  },
};

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="bg-muted inline-flex flex-wrap gap-0.5 rounded-lg p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-colors",
            value === o.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Control({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</span>
      {children}
    </div>
  );
}

const NOTICE_BUTTONS: { code: NoticeCode; label: string }[] = [
  { code: "session-started", label: "session démarrée" },
  { code: "session-ended", label: "session terminée" },
  { code: "context-lost", label: "contexte perdu" },
  { code: "harness-lost", label: "harness perdu" },
];

export function LiveDemo() {
  const sim = useSimulator(INITIAL);
  const [picker, setPicker] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("normal");
  const ws = sim.state.workstreams.find((w) => w.id === sim.state.currentId)!;
  const items = sim.state.items[ws.id] ?? [];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="bg-background grid h-[760px] overflow-hidden rounded-xl border shadow-sm md:grid-cols-[15rem_minmax(0,1fr)]">
        <AgoraProvider
          workstream={ws}
          items={items}
          commands={{
            write: (t) => sim.write(ws.id, t),
            cancel: (turnId) => sim.cancel(ws.id, turnId),
            answerPermission: (requestId, optionId) => sim.answerPermission(ws.id, requestId, optionId),
          }}
          threadList={{
            workstreams: sim.state.workstreams,
            currentId: ws.id,
            open: sim.open,
            create: () => setPicker(true),
          }}
        >
          <aside className="bg-sidebar hidden overflow-y-auto border-e p-2 md:block">
            <ThreadList />
          </aside>
          <main className="min-h-0 min-w-0">
            <Thread autoFocus={false} />
          </main>
        </AgoraProvider>
      </div>

      <div className="bg-card flex flex-col gap-5 rounded-xl border p-4 text-sm">
        <p className="text-muted-foreground text-xs leading-relaxed">
          Écrivez n'importe quoi : le faux serveur rejoue un tour type — réflexion, plan, lecture,
          modification <b>avec permission</b>, tests, réponse. Pendant le tour, le bouton carré annule.
        </p>
        <Control label="Exécution du workstream">
          <Segmented<Execution>
            value={ws.execution}
            onChange={(v) => sim.setExecution(ws.id, v)}
            options={(["starting", "available", "error", "stopped"] as const).map((v) => ({
              value: v,
              label: EXECUTION_LABEL[v],
            }))}
          />
        </Control>
        <Control label="Stockage du journal">
          <Segmented
            value={ws.sendsClosed ? "down" : "up"}
            onChange={(v) =>
              sim.setSendsClosed(
                ws.id,
                v === "down" ? "Stockage du journal indisponible : les envois reprendront à son retour." : undefined,
              )
            }
            options={[
              { value: "up", label: "disponible" },
              { value: "down", label: "indisponible" },
            ]}
          />
        </Control>
        <Control label="Issue du prochain tour">
          <Segmented<Outcome>
            value={outcome}
            onChange={(v) => {
              setOutcome(v);
              sim.outcome.current = v;
            }}
            options={[
              { value: "normal", label: "normale" },
              { value: "failed", label: "échec" },
              { value: "uncertain", label: "incertaine" },
            ]}
          />
        </Control>
        <Control label="Ajouter un avis">
          <div className="flex flex-wrap gap-1.5">
            {NOTICE_BUTTONS.map((b) => (
              <button
                key={b.code}
                type="button"
                onClick={() => sim.addNotice(ws.id, b.code)}
                className="hover:bg-muted rounded-md border px-2 py-1 text-xs"
              >
                {b.label}
              </button>
            ))}
          </div>
        </Control>
        <p className="text-muted-foreground mt-auto text-xs leading-relaxed">
          « Nouveau workstream » ouvre le choix du harness ; le nouveau workstream démarre
          2,5 s puis devient disponible.
        </p>
      </div>
      <HarnessPicker open={picker} onOpenChange={setPicker} onCreate={sim.create} />
    </div>
  );
}

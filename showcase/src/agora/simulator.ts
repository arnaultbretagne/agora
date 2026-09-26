// Un faux serveur Agora pour la démo : il applique les commandes et fait vivre le fil
// comme le ferait la projection du journal ACP.
import { useCallback, useRef, useState } from "react";
import {
  ANSWER,
  NEW_SQL,
  OLD_SQL,
  PROMPT,
  REASONING,
  TEST_LINES,
  notice,
  permission,
  plan,
  reasoning,
  text,
  tool,
  turn,
  uid,
} from "./fixtures";
import type {
  Element,
  Execution,
  NoticeCode,
  PlanEntry,
  ThreadItem,
  ToolElement,
  Turn,
  Workstream,
} from "./model";

export type Outcome = "normal" | "failed" | "uncertain";

export type SimState = {
  workstreams: Workstream[];
  items: Record<string, ThreadItem[]>;
  currentId: string;
};

class Cancelled extends Error {}

type Run = { cancelled: boolean; waiters: Map<string, (optionId: string) => void> };

export function useSimulator(initial: SimState) {
  const [state, setState] = useState(initial);
  const runs = useRef(new Map<string, Run>());
  const outcome = useRef<Outcome>("normal");

  const patchItems = useCallback((wsId: string, fn: (items: ThreadItem[]) => ThreadItem[]) => {
    setState((s) => ({ ...s, items: { ...s.items, [wsId]: fn(s.items[wsId] ?? []) } }));
  }, []);

  const patchTurn = useCallback(
    (wsId: string, turnId: string, fn: (t: Turn) => Turn) =>
      patchItems(wsId, (items) => items.map((i) => (i.kind === "turn" && i.id === turnId ? fn(i) : i))),
    [patchItems],
  );

  const patchWorkstream = useCallback((wsId: string, fn: (ws: Workstream) => Workstream) => {
    setState((s) => ({ ...s, workstreams: s.workstreams.map((w) => (w.id === wsId ? fn(w) : w)) }));
  }, []);

  const script = useCallback(
    async (wsId: string, turnId: string, run: Run) => {
      const sleep = (ms: number) =>
        new Promise<void>((resolve, reject) =>
          setTimeout(() => (run.cancelled ? reject(new Cancelled()) : resolve()), ms),
        );
      const add = (el: Element) => patchTurn(wsId, turnId, (t) => ({ ...t, elements: [...t.elements, el] }));
      const patchEl = <E extends Element>(id: string, fn: (e: E) => E) =>
        patchTurn(wsId, turnId, (t) => ({
          ...t,
          elements: t.elements.map((e) => (e.id === id ? fn(e as E) : e)),
        }));
      const stream = async (el: Extract<Element, { kind: "text" | "reasoning" }>, full: string) => {
        add({ ...el, text: "" });
        const words = full.split(/(\s+)/);
        for (let i = 0; i < words.length; i += 3) {
          await sleep(45);
          const chunk = words.slice(0, i + 3).join("");
          patchEl<typeof el>(el.id, (e) => ({ ...e, text: chunk }));
        }
      };
      const setPlan = (id: string, entries: PlanEntry[]) =>
        patchEl<Extract<Element, { kind: "plan" }>>(id, (e) => ({ ...e, entries }));
      const planEntries = (done: number): PlanEntry[] =>
        ["Lire la projection actuelle", "Ajouter session_id à la vue", "Lancer les tests de projection"].map(
          (content, i) => ({
            content,
            priority: i < 2 ? "high" : "medium",
            status: i < done ? "completed" : i === done ? "in_progress" : "pending",
          }),
        );

      await sleep(900);
      patchTurn(wsId, turnId, (t) => ({ ...t, state: "running" }));
      await sleep(300);
      await stream(reasoning("") as never, REASONING);

      const p = plan(planEntries(0));
      add(p);
      await sleep(500);

      const read = tool({
        title: "Lire contracts/db/projection.sql",
        toolKind: "read",
        status: "in_progress",
        input: { path: "contracts/db/projection.sql" },
      });
      add(read);
      await sleep(900);
      patchEl<ToolElement>(read.id, (e) => ({ ...e, status: "completed", output: OLD_SQL }));
      setPlan(p.id, planEntries(1));
      await sleep(400);

      const perm = permission();
      const edit = tool({
        title: "Modifier contracts/db/projection.sql",
        toolKind: "edit",
        status: "pending",
        input: { path: "contracts/db/projection.sql" },
        diff: { path: "contracts/db/projection.sql", oldText: OLD_SQL, newText: NEW_SQL },
        permission: perm,
      });
      add(edit);
      const answer = await new Promise<string>((resolve) => run.waiters.set(perm.requestId, resolve));
      if (run.cancelled) throw new Cancelled();
      if (answer.startsWith("reject")) {
        patchEl<ToolElement>(edit.id, (e) => ({ ...e, status: "failed", output: "Refusé par l'utilisateur." }));
        await sleep(400);
        await stream(text("") as never, "Modification refusée : je n'ai rien changé. Dites-moi si vous préférez une autre approche.");
        patchTurn(wsId, turnId, (t) => ({ ...t, state: "completed", stopReason: "end_turn" }));
        return;
      }
      patchEl<ToolElement>(edit.id, (e) => ({ ...e, status: "in_progress" }));
      await sleep(700);
      patchEl<ToolElement>(edit.id, (e) => ({ ...e, status: "completed", output: "Fichier modifié." }));
      setPlan(p.id, planEntries(2));

      if (outcome.current === "uncertain") {
        await sleep(900);
        patchTurn(wsId, turnId, (t) => ({
          ...t,
          state: "uncertain",
          uncertainty:
            "La connexion ACP a été coupée après la modification du fichier. Agora ne sait pas si les tests ont été lancés, et n'a rien renvoyé.",
        }));
        return;
      }

      const test = tool({
        title: "npm test -w @agora/journal",
        toolKind: "execute",
        status: "in_progress",
        input: { command: "npm test -w @agora/journal" },
        terminal: { command: "npm test -w @agora/journal", lines: [] },
      });
      add(test);
      for (let i = 1; i <= TEST_LINES.length; i++) {
        await sleep(220);
        if (outcome.current === "failed" && i === 6) {
          patchEl<ToolElement>(test.id, (e) => ({ ...e, status: "failed", output: "Interrompu." }));
          patchTurn(wsId, turnId, (t) => ({
            ...t,
            state: "failed",
            error: "L'agent a répondu par une erreur : overloaded_error (529). Le tour s'arrête là.",
          }));
          return;
        }
        patchEl<ToolElement>(test.id, (e) => ({
          ...e,
          terminal: { command: e.terminal!.command, lines: TEST_LINES.slice(0, i) },
        }));
      }
      patchEl<ToolElement>(test.id, (e) => ({ ...e, status: "completed", output: TEST_LINES.join("\n") }));
      setPlan(p.id, planEntries(3));
      await sleep(400);
      await stream(text("") as never, ANSWER);
      patchTurn(wsId, turnId, (t) => ({ ...t, state: "completed", stopReason: "end_turn" }));
    },
    [patchTurn],
  );

  const write = useCallback(
    (wsId: string, prompt: string) => {
      const t = turn(prompt || PROMPT, "recorded", [], { createdAt: new Date() });
      patchItems(wsId, (items) => [...items, t]);
      patchWorkstream(wsId, (w) => ({ ...w, lastActivity: new Date() }));
      const run: Run = { cancelled: false, waiters: new Map() };
      runs.current.set(t.id, run);
      script(wsId, t.id, run).catch((e) => {
        if (!(e instanceof Cancelled)) throw e;
      });
    },
    [patchItems, patchWorkstream, script],
  );

  const cancel = useCallback(
    (wsId: string, turnId: string) => {
      const run = runs.current.get(turnId);
      if (run) {
        run.cancelled = true;
        run.waiters.forEach((resolve) => resolve("cancelled"));
      }
      patchTurn(wsId, turnId, (t) =>
        t.state !== "recorded" && t.state !== "running"
          ? t // tour déjà clos : l'annulation ne fait rien
          : {
              ...t,
              state: "cancelled",
              stopReason: "cancelled",
              // Un outil pas encore clos garde son statut : sans résultat, assistant-ui
              // l'affiche comme annulé avec le tour.
              elements: t.elements.map((e) =>
                e.kind === "tool" && e.permission && e.permission.answer === undefined
                  ? { ...e, permission: { ...e.permission, answer: "cancelled" } }
                  : e,
              ),
            },
      );
    },
    [patchTurn],
  );

  const answerPermission = useCallback(
    (wsId: string, requestId: string, optionId: string) => {
      patchItems(wsId, (items) =>
        items.map((i) =>
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
      );
      runs.current.forEach((run) => run.waiters.get(requestId)?.(optionId));
    },
    [patchItems],
  );

  const addNotice = useCallback(
    (wsId: string, code: NoticeCode) =>
      patchItems(wsId, (items) => [...items, { ...notice(code), createdAt: new Date() }]),
    [patchItems],
  );

  const setExecution = useCallback(
    (wsId: string, execution: Execution) => patchWorkstream(wsId, (w) => ({ ...w, execution })),
    [patchWorkstream],
  );

  const setSendsClosed = useCallback(
    (wsId: string, reason: string | undefined) => patchWorkstream(wsId, (w) => ({ ...w, sendsClosed: reason })),
    [patchWorkstream],
  );

  const open = useCallback((id: string) => setState((s) => ({ ...s, currentId: id })), []);

  const create = useCallback(
    (harness: string) => {
      const id = uid("ws");
      setState((s) => ({
        ...s,
        currentId: id,
        workstreams: [
          { id, title: "Nouveau workstream", harness, execution: "starting", lastActivity: new Date() },
          ...s.workstreams,
        ],
        items: { ...s.items, [id]: [] },
      }));
      setTimeout(() => {
        patchWorkstream(id, (w) => ({ ...w, execution: "available" }));
        patchItems(id, (items) => [
          ...items,
          { ...notice("session-started", `Session démarrée — ${harness}.`), createdAt: new Date() },
        ]);
      }, 2500);
    },
    [patchItems, patchWorkstream],
  );

  return {
    state,
    outcome,
    write,
    cancel,
    answerPermission,
    addNotice,
    setExecution,
    setSendsClosed,
    open,
    create,
  };
}


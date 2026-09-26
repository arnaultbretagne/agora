import type { ThreadMessageLike } from "@assistant-ui/react";
import type { PropsWithChildren } from "react";
import { ApprovalCard } from "@/components/assistant-ui/elements/approval-card";
import { AgentPlan } from "@/components/assistant-ui/elements/agent-plan";
import { CodeDiff, type DiffLine } from "@/components/assistant-ui/elements/code-diff";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning";
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";
import { TodoList } from "@/components/assistant-ui/elements/todo-list";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import type { ThreadComponents, ThreadGroupPart } from "@/components/assistant-ui/elements/thread.aui";
import { DiffViewer } from "@/components/ui/diff-viewer";
import {
  NEW_SQL,
  OLD_SQL,
  PROMPT,
  REASONING,
  TEST_LINES,
  editTool,
  readTool,
  reasoning,
  testTool,
  text,
  tool,
  turn,
} from "@/agora/fixtures";
import { planItems } from "@/agora/toolkit";
import { Grid, Group, MessagesPreview, RawPreview, Section, Variant } from "../ui";

const MARKDOWN = `## Ce qui change

La vue \`turn_projection\` gagne une colonne. Trois points :

1. une **jointure** sur \`sessions\` ;
2. la colonne dans le \`group by\` ;
3. un test de *changement de session*.

\`\`\`sql
select t.id, s.id as session_id
from turns t
join sessions s on s.id = t.session_id;
\`\`\`

| Tour | Session | État |
| --- | --- | --- |
| 41 | s-7 | terminé |
| 42 | s-8 | incertain |

> Une vue simple : rien à rafraîchir.

Voir [ADR 0005](https://github.com/arnaultbretagne/agora) pour le stockage.`;

export function TextSection() {
  return (
    <Section
      id="texte"
      title="Texte"
      lead="Le rendu Markdown des réponses : titres, listes, code, tableaux, citations, liens."
      binding={
        <>
          Fragments <code>agent_message_chunk</code> consécutifs → part <code>text</code> →{" "}
          <code>MarkdownText</code> (registre). Le HTML brut n'est pas interprété.
        </>
      }
    >
      <Variant label="Réponse riche" code="MarkdownText">
        <MessagesPreview items={[turn("Résume le changement.", "completed", [text(MARKDOWN)])]} />
      </Variant>
    </Section>
  );
}

const reasoningGroup =
  (variant: "outline" | "ghost" | "muted"): NonNullable<ThreadComponents["ReasoningGroup"]> =>
  ({ group, children }: PropsWithChildren<{ group: ThreadGroupPart }>) => {
    const running = group.status.type === "running";
    return (
      <ReasoningRoot variant={variant} streaming={running}>
        <ReasoningTrigger active={running} />
        <ReasoningContent aria-busy={running}>
          <ReasoningText>{children}</ReasoningText>
        </ReasoningContent>
      </ReasoningRoot>
    );
  };

const toolGroup =
  (variant: "outline" | "ghost" | "muted"): NonNullable<ThreadComponents["ToolGroup"]> =>
  ({ group, children }: PropsWithChildren<{ group: ThreadGroupPart }>) => (
    <ToolGroupRoot variant={variant} defaultOpen>
      <ToolGroupTrigger count={group.indices.length} active={group.status.type === "running"} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );

const OPEN: ThreadComponents = { ToolGroup: toolGroup("ghost") };

export function ReasoningSection() {
  return (
    <Section
      id="reflexion"
      title="Réflexion"
      lead="Le raisonnement de l'agent, replié par défaut, avec un aperçu défilant pendant le flux."
      binding={
        <>
          Fragments <code>agent_thought_chunk</code> → part <code>reasoning</code> →{" "}
          <code>Reasoning</code> (registre). Option <code>variant</code> : <code>outline</code>{" "}
          (défaut), <code>ghost</code>, <code>muted</code>.
        </>
      }
    >
      <Grid cols={3}>
        {(["outline", "ghost", "muted"] as const).map((v) => (
          <Variant key={v} label={`variant="${v}"`} code="terminée, repliée">
            <MessagesPreview
              components={{ ReasoningGroup: reasoningGroup(v) }}
              items={[turn(PROMPT, "completed", [reasoning(REASONING), text("Je propage `session_id` par une jointure.")])]}
            />
          </Variant>
        ))}
      </Grid>
      <Grid cols={2}>
        <Variant label="Pendant le flux" code="streaming" note="Aperçu ouvert qui suit les derniers mots.">
          <MessagesPreview items={[turn(PROMPT, "running", [reasoning(REASONING)])]} />
        </Variant>
        <Variant label="Ouverte" code="defaultOpen" note="Primitives utilisées directement.">
          <ReasoningRoot defaultOpen>
            <ReasoningTrigger duration={4} />
            <ReasoningContent>
              <ReasoningText>
                <p className="text-sm">{REASONING}</p>
              </ReasoningText>
            </ReasoningContent>
          </ReasoningRoot>
        </Variant>
      </Grid>
    </Section>
  );
}

export function ToolSection() {
  const failed = tool({
    title: "Lire contracts/db/archive.sql",
    toolKind: "read",
    status: "failed",
    input: { path: "contracts/db/archive.sql" },
    output: "ENOENT: no such file or directory, open 'contracts/db/archive.sql'",
  });
  const search = tool({
    title: "Chercher « session_id » dans le dépôt",
    toolKind: "search",
    status: "completed",
    input: { pattern: "session_id", paths: ["contracts", "packages"], ignore: ["node_modules", "dist"] },
    output: "contracts/db/schema.sql:41\npackages/journal/src/project.ts:18\npackages/journal/test/project.test.ts:7",
  });
  return (
    <Section
      id="outils"
      title="Outils"
      lead="Chaque appel d'outil ACP, avec son titre, son statut, son entrée et son résultat. Les appels consécutifs sont regroupés."
      binding={
        <>
          <code>tool_call</code> + <code>tool_call_update</code> fusionnés → part <code>tool-call</code> :{" "}
          <code>toolName</code> = sorte ACP, titre dans <code>artifact</code>, <code>result</code> toujours
          présent quand l'outil est clos. <code>ToolFallback</code> (registre) modifié pour afficher le titre ;
          groupe <code>ToolGroup</code> (registre).
        </>
      }
    >
      <Group title="États d'un outil" note="Groupes ouverts ici pour montrer l'outil ; dans le Thread, ils sont repliés par défaut, même pour un seul outil.">
        <Grid cols={2}>
          <Variant label="En cours" code="in_progress · running">
            <MessagesPreview components={OPEN} items={[turn(PROMPT, "running", [readTool("in_progress")])]} />
          </Variant>
          <Variant label="Terminé" code="completed" note="Déplier pour voir l'entrée et le résultat.">
            <MessagesPreview components={OPEN} items={[turn(PROMPT, "completed", [search])]} />
          </Variant>
          <Variant label="Échoué" code="failed · isError">
            <MessagesPreview components={OPEN} items={[turn(PROMPT, "completed", [failed])]} />
          </Variant>
          <Variant label="Annulé avec le tour" code="incomplete · cancelled">
            <MessagesPreview components={OPEN} items={[turn(PROMPT, "cancelled", [readTool("in_progress")])]} />
          </Variant>
        </Grid>
      </Group>
      <Group
        title="Groupe d'outils"
        note="Option variant du ToolGroup. Le Thread adapté utilise ghost et s'ouvre dès qu'une permission attend."
      >
        <Grid cols={3}>
          {(["ghost", "outline", "muted"] as const).map((v) => (
            <Variant key={v} label={`variant="${v}"`}>
              <MessagesPreview
                components={{ ToolGroup: toolGroup(v) }}
                items={[turn(PROMPT, "completed", [readTool(), search, testTool()])]}
              />
            </Variant>
          ))}
        </Grid>
      </Group>
    </Section>
  );
}

const approvalMessage = (
  id: string,
  approval: NonNullable<Extract<Exclude<ThreadMessageLike["content"], string>[number], { type: "tool-call" }>["approval"]>,
): ThreadMessageLike[] => [
  {
    id: `${id}-a`,
    role: "assistant",
    status: { type: "requires-action", reason: "tool-calls" },
    content: [
      {
        type: "tool-call",
        toolCallId: `${id}-call`,
        toolName: "execute",
        args: { command: "npm run db:reset" },
        argsText: '{ "command": "npm run db:reset" }',
        artifact: { title: "npm run db:reset" },
        approval,
      },
    ],
  },
];

export function PermissionSection() {
  return (
    <Section
      id="permissions"
      title="Permissions"
      lead="Une demande de permission ACP s'affiche dans l'outil qu'elle concerne. Les boutons sont interactifs."
      binding={
        <>
          <code>session/request_permission</code> → champ <code>approval</code> du <code>tool-call</code> ;
          les quatre sortes ACP (<code>allow-once</code>, <code>allow-always</code>, <code>reject-once</code>,{" "}
          <code>reject-always</code>) sont celles d'assistant-ui. Réponse via{" "}
          <code>onRespondToToolApproval</code> → Répondre à une permission.
        </>
      }
    >
      <Group title="Dans le contrat">
        <Grid cols={2}>
          <Variant label="En attente — quatre options ACP" code="requires-action" note="Cliquer une option : la demande se ferme.">
            <MessagesPreview items={[turn(PROMPT, "running", [editTool("pending", null)])]} />
          </Variant>
          <Variant label="Autorisée une fois" code='optionId="allow-once"'>
            <MessagesPreview items={[turn(PROMPT, "completed", [editTool("completed", "allow-once")])]} />
          </Variant>
          <Variant label="Refusée" code='optionId="reject-once"'>
            <MessagesPreview items={[turn(PROMPT, "completed", [editTool("failed", "reject-once")])]} />
          </Variant>
          <Variant label="Annulée avec le tour" code='resolution="cancelled"'>
            <MessagesPreview items={[turn(PROMPT, "cancelled", [editTool("pending", "cancelled")])]} />
          </Variant>
        </Grid>
      </Group>
      <Group
        title="Autres présentations possibles"
        note="Options du champ approval qu'ACP n'exprime pas aujourd'hui : utiles si Agora ajoute ses propres questions."
      >
        <Grid cols={2}>
          <Variant label="Décision simple, sans options" code="options absent">
            <RawPreview messages={approvalMessage("plain", { id: "p1" })} />
          </Variant>
          <Variant label="Confirmation avant « toujours »" code="confirm: true">
            <RawPreview
              messages={approvalMessage("confirm", {
                id: "p2",
                options: [
                  { id: "once", kind: "allow-once", label: "Autoriser une fois" },
                  {
                    id: "always",
                    kind: "allow-always",
                    label: "Toujours autoriser",
                    grants: ["execute: npm run db:*"],
                    confirm: { title: "Toujours autoriser ?", description: "Toutes les commandes npm run db:* passeront sans demande." },
                  },
                  { id: "no", kind: "reject-once", label: "Refuser" },
                ],
              })}
            />
          </Variant>
          <Variant label="Choix dans une liste" code='display="select"'>
            <RawPreview
              messages={approvalMessage("select", {
                id: "p3",
                display: "select",
                prompt: "Quelle base réinitialiser ?",
                options: [
                  { id: "test", kind: "_choice", label: "Base de test" },
                  { id: "dev", kind: "_choice", label: "Base de développement" },
                ],
              })}
            />
          </Variant>
          <Variant label="Réponse libre" code='display="text"'>
            <RawPreview
              messages={approvalMessage("text", {
                id: "p4",
                display: "text",
                prompt: "Quel nom donner à la migration ?",
              })}
            />
          </Variant>
        </Grid>
      </Group>
      <Group title="Alternative du registre" note="ApprovalCard (elements-approval-card), carte autonome pilotée par props, en quatre états.">
        <Grid cols={4}>
          {(["request", "running", "done", "denied"] as const).map((s) => (
            <Variant key={s} label={`state="${s}"`}>
              <ApprovalCard
                state={s}
                command="npm run db:reset"
                title="Réinitialiser la base"
                subtitle="Supprime et recrée le schéma"
                onAllowOnce={() => {}}
                onAlwaysAllow={() => {}}
                onDeny={() => {}}
              />
            </Variant>
          ))}
        </Grid>
      </Group>
    </Section>
  );
}

const CODE_DIFF_LINES: DiffLine[] = [
  { kind: "context", text: "select t.id," },
  { kind: "context", text: "       t.workstream_id," },
  { kind: "added", text: "       s.id as session_id," },
  { kind: "context", text: "from turns t" },
  { kind: "added", text: "join sessions s on s.id = t.session_id" },
  { kind: "removed", text: "group by t.id, t.workstream_id;" },
  { kind: "added", text: "group by t.id, t.workstream_id, s.id;" },
];

const diff = { oldFile: { content: OLD_SQL, name: "projection.sql" }, newFile: { content: NEW_SQL, name: "projection.sql" } };

export function DiffSection() {
  return (
    <Section
      id="diff"
      title="Diff"
      lead="Le résultat d'un outil edit : le diff ACP (chemin, ancien texte, nouveau texte) va directement au DiffViewer."
      binding={
        <>
          Outil <code>edit</code> → <code>DiffViewer</code> (registre) avec <code>oldFile</code> /{" "}
          <code>newFile</code>. Options : <code>viewMode</code>, <code>variant</code>, <code>size</code>,{" "}
          <code>showLineNumbers</code>, <code>showIcon</code>, <code>showStats</code>.
        </>
      }
    >
      <Group title="viewMode">
        <Grid cols={2}>
          <Variant label='viewMode="unified"' code="défaut">
            <DiffViewer {...diff} viewMode="unified" />
          </Variant>
          <Variant label='viewMode="split"'>
            <DiffViewer {...diff} viewMode="split" />
          </Variant>
        </Grid>
      </Group>
      <Group title="variant">
        <Grid cols={3}>
          {(["default", "ghost", "muted"] as const).map((v) => (
            <Variant key={v} label={`variant="${v}"`}>
              <DiffViewer {...diff} variant={v} />
            </Variant>
          ))}
        </Grid>
      </Group>
      <Group title="size">
        <Grid cols={3}>
          {(["sm", "default", "lg"] as const).map((s) => (
            <Variant key={s} label={`size="${s}"`}>
              <DiffViewer {...diff} size={s} />
            </Variant>
          ))}
        </Grid>
      </Group>
      <Group title="Affichages optionnels">
        <Grid cols={3}>
          <Variant label="showLineNumbers={false}">
            <DiffViewer {...diff} showLineNumbers={false} />
          </Variant>
          <Variant label="showIcon">
            <DiffViewer {...diff} showIcon />
          </Variant>
          <Variant label="showStats={false}">
            <DiffViewer {...diff} showStats={false} />
          </Variant>
        </Grid>
      </Group>
      <Group title="Alternative du registre" note="CodeDiff (elements-code-diff) : lignes déjà classées, pas de calcul de diff.">
        <Grid cols={2}>
          <Variant label="CodeDiff">
            <CodeDiff filename="contracts/db/projection.sql" additions={4} deletions={1} lines={CODE_DIFF_LINES} cycle={0} />
          </Variant>
        </Grid>
      </Group>
    </Section>
  );
}

export function TerminalSection() {
  return (
    <Section
      id="terminal"
      title="Terminal"
      lead="Le résultat d'un outil execute : la commande et sa sortie, qui défile pendant l'exécution."
      binding={
        <>
          Outil <code>execute</code> → <code>TerminalBlock</code> (registre <code>elements-terminal-block</code>).
          Options : <code>variant</code> <code>paper</code> ou <code>ink</code>, <code>visibleCount</code>,{" "}
          <code>done</code>.
        </>
      }
    >
      <Grid cols={2}>
        {(["ink", "paper"] as const).map((v) => (
          <Variant key={`${v}-done`} label={`variant="${v}"`} code="done">
            <TerminalBlock command="npm test -w @agora/journal" lines={TEST_LINES} visibleCount={TEST_LINES.length} done variant={v} />
          </Variant>
        ))}
        {(["ink", "paper"] as const).map((v) => (
          <Variant key={`${v}-live`} label={`variant="${v}"`} code="en cours · visibleCount=5">
            <TerminalBlock command="npm test -w @agora/journal" lines={TEST_LINES} visibleCount={5} done={false} variant={v} />
          </Variant>
        ))}
      </Grid>
    </Section>
  );
}

export function PlanSection() {
  const entries = [
    { content: "Lire la projection actuelle", status: "completed", priority: "high" },
    { content: "Ajouter session_id à la vue", status: "in_progress", priority: "high" },
    { content: "Lancer les tests de projection", status: "pending", priority: "medium" },
  ] as const;
  return (
    <Section
      id="plan"
      title="Plan"
      lead="Le dernier plan ACP reçu dans le tour, avec l'avancement de chaque étape."
      binding={
        <>
          <code>plan</code> → part <code>data</code> nommée <code>plan</code> → <code>TodoList</code> (registre{" "}
          <code>elements-todo-list</code>) via <code>makeAssistantDataUI</code>. <code>pending</code> /{" "}
          <code>in_progress</code> / <code>completed</code> → <code>pending</code> / <code>active</code> /{" "}
          <code>done</code>.
        </>
      }
    >
      <Grid cols={3}>
        <Variant label="Plan ACP" code="TodoList" note="Les trois états qu'ACP connaît.">
          <TodoList items={planItems([...entries])} />
        </Variant>
        <Variant label="Tous les états du composant" code="pending · active · done · failed" note="failed et reason n'ont pas d'équivalent ACP.">
          <TodoList
            items={[
              { id: "1", text: "Lire la projection actuelle", status: "done" },
              { id: "2", text: "Ajouter session_id à la vue", status: "active" },
              { id: "3", text: "Migrer les anciennes lignes", status: "failed", reason: "table verrouillée" },
              { id: "4", text: "Lancer les tests", status: "pending" },
            ]}
          />
        </Variant>
        <Variant label="Alternative : AgentPlan" code="elements-agent-plan" note="Une étape active, pas d'état par étape.">
          <AgentPlan steps={entries.map((e) => e.content)} activeIndex={1} />
        </Variant>
      </Grid>
    </Section>
  );
}

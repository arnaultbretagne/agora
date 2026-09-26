import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  CompositeAttachmentAdapter,
  MessagePrimitive,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { Unstable_TriggerAdapter, Unstable_TriggerItem } from "@assistant-ui/core";
import { useState, type ReactNode } from "react";
import { ComposerAddAttachment, ComposerAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { ComposerTriggerPopover } from "@/components/assistant-ui/elements/composer-trigger-popover.aui";
import {
  ContextDisplayBar,
  ContextDisplayRing,
  ContextDisplayText,
  type TokenUsage,
} from "@/components/assistant-ui/elements/context-display";
import { GuardrailNotice } from "@/components/assistant-ui/elements/guardrail-notice";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { MessageTiming } from "@/components/assistant-ui/elements/message-timing.aui";
import { ModelSelector, type ModelOption } from "@/components/assistant-ui/elements/model-selector.aui";
import { StoppedRun } from "@/components/assistant-ui/elements/stopped-run";
import { ThinkingIndicator } from "@/components/assistant-ui/elements/thinking-indicator";
import { ToolError } from "@/components/assistant-ui/elements/tool-error";
import { AgoraProvider } from "@/agora/runtime";
import { Grid, Group, RawPreview, Section, THREAD_VARS, Variant, WS } from "../ui";

const MODELS: ModelOption[] = [
  { id: "opus", name: "Claude Opus 5.5", description: "Le plus capable", efforts: true },
  { id: "sonnet", name: "Claude Sonnet 5", description: "Rapide et capable", efforts: true },
  { id: "haiku", name: "Claude Haiku 4.5", description: "Le plus rapide" },
  { id: "gpt", name: "GPT-5 (codex)", description: "Harness codex seulement", disabled: true },
];

const usage = (total: number): TokenUsage => ({
  totalTokens: total,
  inputTokens: Math.round(total * 0.7),
  cachedInputTokens: Math.round(total * 0.4),
  outputTokens: Math.round(total * 0.2),
  reasoningTokens: Math.round(total * 0.1),
});

const COMMANDS: Unstable_TriggerItem[] = [
  { id: "review", type: "command", label: "review", description: "Relire les changements en cours" },
  { id: "compact", type: "command", label: "compact", description: "Compacter le contexte du harness" },
  { id: "init", type: "command", label: "init", description: "Créer un AGENTS.md" },
  { id: "model", type: "command", label: "model", description: "Changer de modèle" },
];

const SLASH: Unstable_TriggerAdapter = {
  categories: () => [{ id: "commands", label: "Commandes du harness" }],
  categoryItems: () => COMMANDS,
  search: (q: string) => COMMANDS.filter((c) => c.label.includes(q.toLowerCase())),
};

function MiniComposer({ children, placeholder }: { children?: ReactNode; placeholder: string }) {
  return (
    <ComposerPrimitive.Root className="border-foreground/10 flex w-full flex-col gap-2 rounded-2xl border p-2">
      {children}
      <ComposerPrimitive.Input
        placeholder={placeholder}
        rows={1}
        className="placeholder:text-muted-foreground/60 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-sm outline-none"
      />
    </ComposerPrimitive.Root>
  );
}

function SlashComposer() {
  const [last, setLast] = useState<string>();
  return (
    <AgoraProvider workstream={WS} items={[]}>
      <div style={THREAD_VARS} className="flex flex-col gap-2">
        <ComposerPrimitive.Unstable_TriggerPopoverRoot>
          <MiniComposer placeholder="Taper / pour les commandes">
            <ComposerTriggerPopover
              char="/"
              adapter={SLASH}
              action={{ onExecute: (item) => setLast(item.label), removeOnExecute: true }}
              backLabel="Retour"
              emptyItemsLabel="Aucune commande"
            />
          </MiniComposer>
        </ComposerPrimitive.Unstable_TriggerPopoverRoot>
        {last && <p className="text-muted-foreground text-xs">Commande choisie : /{last}</p>}
      </div>
    </AgoraProvider>
  );
}

function AttachmentComposer() {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: (m) => m,
    onNew: async () => {},
    adapters: {
      attachments: new CompositeAttachmentAdapter([new SimpleImageAttachmentAdapter(), new SimpleTextAttachmentAdapter()]),
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root style={THREAD_VARS}>
        <MiniComposer placeholder="Joindre une image ou un fichier texte">
          <ComposerAttachments />
          <div className="flex">
            <ComposerAddAttachment />
          </div>
        </MiniComposer>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

const TIMED: ThreadMessageLike[] = [
  {
    id: "timed",
    role: "assistant",
    status: { type: "complete", reason: "stop" },
    content: [{ type: "text", text: "Les trois tests de projection passent." }],
    metadata: {
      timing: {
        streamStartTime: Date.now() - 4200,
        firstTokenTime: 620,
        totalStreamTime: 4200,
        tokenCount: 312,
        tokensPerSecond: 74.3,
        totalChunks: 58,
        toolCallCount: 3,
      },
    },
  },
];

export function OutOfContractSection() {
  return (
    <Section
      id="hors-contrat"
      title="Hors contrat, déjà disponible"
      lead="Ce que le registre fournit pour les besoins listés comme futurs dans le contrat. À regarder pour décider s'ils entrent dans la première version."
    >
      <Group title="Choix du modèle" note="ModelSelector (registre model-selector). Options : variant, size, searchable, efforts de raisonnement par modèle, modèle désactivé.">
        <Grid cols={3}>
          {(["outline", "ghost", "muted"] as const).map((v) => (
            <Variant key={v} label={`variant="${v}"`}>
              <AgoraProvider workstream={WS} items={[]}>
                <ModelSelector models={MODELS} defaultValue="opus" variant={v} />
              </AgoraProvider>
            </Variant>
          ))}
          {(["sm", "default", "lg"] as const).map((s) => (
            <Variant key={s} label={`size="${s}"`} code={s === "lg" ? "searchable" : undefined}>
              <AgoraProvider workstream={WS} items={[]}>
                <ModelSelector models={MODELS} defaultValue="sonnet" size={s} searchable={s === "lg"} />
              </AgoraProvider>
            </Variant>
          ))}
        </Grid>
      </Group>
      <Group title="Consommation de contexte" note="ContextDisplay (registre context-display) : trois présentations, survol pour le détail. Alimenté par usage ACP.">
        <Grid cols={3}>
          {[
            { label: "Ring", C: ContextDisplayRing },
            { label: "Bar", C: ContextDisplayBar },
            { label: "Text", C: ContextDisplayText },
          ].map(({ label, C }) => (
            <Variant key={label} label={`ContextDisplay.${label}`} code="20 % · 65 % · 92 %">
              <div className="flex items-center gap-4">
                {[40_000, 130_000, 184_000].map((t) => (
                  <C key={t} modelContextWindow={200_000} usage={usage(t)} side="top" />
                ))}
              </div>
            </Variant>
          ))}
        </Grid>
      </Group>
      <Grid cols={3}>
        <Variant label="Commandes slash" code="ComposerTriggerPopover" note="available_commands ACP. Taper « / » dans la saisie.">
          <SlashComposer />
        </Variant>
        <Variant label="Pièces jointes" code="Attachment" note="Nécessite un adaptateur attachments ; ACP accepte images et ressources.">
          <AttachmentComposer />
        </Variant>
        <Variant label="Durée d'un tour" code="MessageTiming" note="Premier jeton, durée, débit : survol.">
          <RawPreview messages={TIMED}>
            <ThreadPrimitive.Messages>
              {() => (
                <MessagePrimitive.Root className="flex items-center gap-2">
                  <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
                  <MessageTiming />
                </MessagePrimitive.Root>
              )}
            </ThreadPrimitive.Messages>
          </RawPreview>
        </Variant>
      </Grid>
    </Section>
  );
}

export function AlternativesSection() {
  return (
    <Section
      id="alternatives"
      title="Alternatives du registre"
      lead="Des composants autonomes, pilotés par props, qui pourraient remplacer un choix du contrat. Chacun est montré à l'endroit où il servirait."
    >
      <Grid cols={2}>
        <Variant label="Tour enregistré ou réponse vide" code="ThinkingIndicator" note="À la place de l'indicateur ●.">
          <div className="flex flex-col gap-3">
            <ThinkingIndicator label="Envoi au harness" elapsed="2 s" />
            <ThinkingIndicator label="Lecture de contracts/db/projection.sql" elapsed="14 s" />
          </div>
        </Variant>
        <Variant label="Tour annulé" code="StoppedRun" note="À la place de la ligne « Tour annulé ». Continuer = une nouvelle commande Écrire.">
          <StoppedRun
            words={"Je modifie la vue turn_projection pour ajouter la colonne session_id puis je".split(" ")}
            reason="Annulé à la demande"
            onContinue={() => {}}
            onDiscard={() => {}}
          />
        </Variant>
        <Variant label="Outil échoué" code="ToolError" note="Réessayer n'existe pas dans ACP : seulement l'affichage.">
          <ToolError
            name="read"
            target="contracts/db/archive.sql"
            message="ENOENT: no such file or directory"
            attempt={1}
            maxAttempts={1}
            retrying={false}
          />
        </Variant>
        <Variant label="Refus du modèle" code="GuardrailNotice" note="Pour un stopReason refusal d'ACP.">
          <GuardrailNotice
            title="Demande refusée par le modèle"
            explanation="Le modèle a refusé de supprimer la base de production."
            policy="stopReason: refusal"
            alternatives={["Réinitialiser la base de test", "Générer le script sans l'exécuter"]}
          />
        </Variant>
      </Grid>
    </Section>
  );
}

const SWATCHES = [
  ["background", "fond"],
  ["card", "carte"],
  ["muted", "atténué"],
  ["accent", "accent"],
  ["border", "filet"],
  ["foreground", "encre"],
  ["muted-foreground", "texte atténué"],
  ["primary", "terracotta"],
  ["destructive", "erreur"],
  ["success", "succès"],
  ["warning", "alerte"],
  ["teal", "sarcelle"],
  ["amber", "ambre"],
] as const;

export function CharterSection() {
  return (
    <Section
      id="charte"
      title="Charte"
      lead="Les couleurs et les polices de l'ancienne interface d'Agora, reportées sur les variables des composants. Même page en clair et en sombre."
    >
      <Grid cols={2}>
        <Variant label="Couleurs" code="index.css">
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-5">
            {SWATCHES.map(([name, label]) => (
              <div key={name} className="flex flex-col gap-1.5">
                <div className="h-10 rounded-md border" style={{ background: `var(--${name})` }} />
                <span className="text-xs">{label}</span>
                <code className="text-muted-foreground font-mono text-[10px]">--{name}</code>
              </div>
            ))}
          </div>
        </Variant>
        <Variant label="Polices" code="Newsreader · Inter · JetBrains Mono">
          <div className="flex flex-col gap-3">
            <p className="font-heading text-3xl">Agora garde le fil.</p>
            <p className="text-[15px] leading-relaxed">
              Le serveur détient la vérité ; l'interface affiche ce qu'il envoie et agit par des commandes.
            </p>
            <p className="font-mono text-sm">session/request_permission → approval</p>
          </div>
        </Variant>
      </Grid>
    </Section>
  );
}

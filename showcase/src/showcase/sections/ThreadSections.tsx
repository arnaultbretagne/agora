import { useState } from "react";
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { Composer } from "@/components/assistant-ui/elements/thread.aui";
import { ConnectionState } from "@/components/assistant-ui/elements/connection-state";
import { Button } from "@/components/ui/button";
import {
  ExecutionBadgeView,
  ExecutionBannerView,
  HarnessPicker,
  NoticeView,
  SendsClosedBanner,
  SendsClosedBannerView,
  TurnBadgeView,
  UncertainCalloutView,
} from "@/agora/components";
import { PROMPT, editTool, fullTurn, notice, readTool, reasoning, REASONING, text, turn } from "@/agora/fixtures";
import { NOTICE_TEXT, type NoticeCode, type Workstream } from "@/agora/model";
import { AgoraProvider } from "@/agora/runtime";
import { Grid, Group, MessagesPreview, Section, THREAD_VARS, Variant, WS } from "../ui";

const WORKSTREAMS: Workstream[] = [
  { id: "a", title: "Projection des tours", harness: "claude-code", execution: "available" },
  { id: "b", title: "Revue des permissions", harness: "claude-code", execution: "starting" },
  { id: "c", title: "Essai OpenCode", harness: "opencode", execution: "error" },
  { id: "d", title: "Migration du schéma", harness: "codex", execution: "stopped" },
];

function SidebarPreview({ workstreams, loading }: { workstreams: Workstream[]; loading?: boolean }) {
  const [current, setCurrent] = useState(workstreams[0]?.id ?? "");
  return (
    <AgoraProvider
      workstream={WS}
      items={[]}
      threadList={{ workstreams, currentId: current, open: setCurrent, create: () => {}, loading }}
    >
      <div className="bg-sidebar rounded-lg border p-2">
        <ThreadList />
      </div>
    </AgoraProvider>
  );
}

export function SidebarSection() {
  const [picker, setPicker] = useState(false);
  return (
    <Section
      id="barre-laterale"
      title="Barre latérale"
      lead="La liste des workstreams, le bouton de création et l'état de l'exécution de chacun."
      binding={
        <>
          <code>adapters.threadList</code> : <code>threads</code> = workstreams, état dans{" "}
          <code>custom</code> ; <code>onSwitchToThread</code> ouvre le fil ;{" "}
          <code>onSwitchToNewThread</code> ouvre le choix du harness. Le menu Renommer / Archiver /
          Supprimer du registre est retiré : ces commandes n'existent pas.
        </>
      }
    >
      <Grid cols={3}>
        <Variant label="Liste" code="ThreadList" note="Un point par état d'exécution ; la recherche filtre par titre.">
          <SidebarPreview workstreams={WORKSTREAMS} />
        </Variant>
        <Variant label="Vide" code="threads: []" note="Seul le bouton de création reste.">
          <SidebarPreview workstreams={[]} />
        </Variant>
        <Variant label="Chargement" code="isLoading: true">
          <SidebarPreview workstreams={[]} loading />
        </Variant>
      </Grid>
      <Grid cols={2}>
        <Variant label="Badge d'état de l'exécution" code="Badge (registre) + point" note="Version longue et version point seul (utilisée dans la liste).">
          <div className="flex flex-wrap items-center gap-2">
            {(["starting", "available", "error", "stopped"] as const).map((e) => (
              <ExecutionBadgeView key={e} execution={e} />
            ))}
            <span className="text-muted-foreground mx-1 text-xs">·</span>
            {(["starting", "available", "error", "stopped"] as const).map((e) => (
              <ExecutionBadgeView key={e} execution={e} compact />
            ))}
          </div>
        </Variant>
        <Variant label="Choix du harness" code="HarnessPicker (à nous) · Dialog" note="Ouvert par « Nouveau workstream », puis commande Créer.">
          <Button variant="outline" onClick={() => setPicker(true)}>
            Ouvrir le choix du harness
          </Button>
          <HarnessPicker open={picker} onOpenChange={setPicker} onCreate={() => {}} />
        </Variant>
      </Grid>
    </Section>
  );
}

export function TurnSection() {
  return (
    <Section
      id="tours"
      title="Messages et états du tour"
      lead="Un tour devient un message utilisateur suivi d'une réponse. Chaque état du tour, rendu par le vrai Thread adapté."
      binding={
        <>
          <code>UserMessage</code> + badge ; <code>AssistantMessage</code> avec <code>status</code> :
          enregistré et en cours → <code>running</code>, permission en attente →{" "}
          <code>requires-action</code>, terminé → <code>complete</code>, annulé →{" "}
          <code>incomplete/cancelled</code>, échoué → <code>incomplete/error</code>, incertain →{" "}
          <code>incomplete/other</code>.
        </>
      }
    >
      <Grid cols={2}>
        <Variant label="Enregistré" code="running · vide" note="Écrit par Agora, pas encore envoyé : badge et indicateur ●.">
          <MessagesPreview items={[turn(PROMPT, "recorded")]} />
        </Variant>
        <Variant label="En cours" code="running" note="La réflexion défile encore, le texte arrive.">
          <MessagesPreview
            items={[turn(PROMPT, "running", [reasoning(REASONING), text("Je commence par lire la projection actuelle")])]}
          />
        </Variant>
        <Variant label="Permission en attente" code="requires-action" note="Le tour attend une réponse ; le groupe d'outils s'ouvre tout seul.">
          <MessagesPreview items={[turn(PROMPT, "running", [readTool(), editTool("pending", null)])]} />
        </Variant>
        <Variant label="Terminé" code="complete">
          <MessagesPreview
            items={[turn("Combien de tours dans ce workstream ?", "completed", [text("Trois tours, dont un **incertain**.")])]}
          />
        </Variant>
        <Variant label="Annulé" code="incomplete · cancelled" note="L'outil encore en cours, sans résultat, s'affiche barré.">
          <MessagesPreview
            items={[turn(PROMPT, "cancelled", [text("Je lis d'abord la projection."), readTool("in_progress")])]}
          />
        </Variant>
        <Variant label="Échoué" code="incomplete · error" note="MessagePrimitive.Error affiche le message de l'agent.">
          <MessagesPreview
            items={[
              turn(PROMPT, "failed", [text("Je lance les tests.")], {
                error: "L'agent a répondu par une erreur : overloaded_error (529).",
              }),
            ]}
          />
        </Variant>
        <Variant label="Incertain" code="incomplete · other" note="Badge sur la demande et explication dans la réponse. Jamais renvoyé automatiquement.">
          <MessagesPreview
            items={[
              turn(PROMPT, "uncertain", [text("Je modifie la vue puis je")], {
                uncertainty:
                  "La connexion ACP a été coupée pendant le tour. Agora ne sait pas si la vue a été modifiée, et n'a rien renvoyé.",
              }),
            ]}
          />
        </Variant>
        <Variant label="Tour complet" code="tous les blocs" note="Réflexion, plan, lecture, modification autorisée, tests, réponse.">
          <MessagesPreview items={[fullTurn()]} />
        </Variant>
      </Grid>
      <Grid cols={2}>
        <Variant label="Badges d'état du tour" code="TurnBadge (à nous)" note="Seuls « enregistré » et « incertain » ont un badge.">
          <div className="flex gap-2">
            <TurnBadgeView state="recorded" />
            <TurnBadgeView state="uncertain" />
          </div>
        </Variant>
        <Variant label="Explication d'un tour incertain" code="TurnOutcome (à nous)">
          <UncertainCalloutView />
        </Variant>
      </Grid>
    </Section>
  );
}

const CODES: NoticeCode[] = ["session-started", "session-ended", "context-lost", "harness-lost"];

export function NoticeSection() {
  return (
    <Section
      id="avis"
      title="Avis"
      lead="Les événements du système entre deux tours."
      binding={
        <>
          Message <code>system</code>, code dans <code>metadata.custom</code>, rendu par{" "}
          <code>Notice</code> (à nous) : <code>Thread</code> est modifié pour ne plus rendre les messages{" "}
          <code>system</code> comme des réponses.
        </>
      }
    >
      <Grid cols={2}>
        <Variant label="Les quatre avis" code="NoticeView">
          <div className="flex flex-col gap-3">
            {CODES.map((c) => (
              <NoticeView key={c} code={c} text={NOTICE_TEXT[c]} />
            ))}
          </div>
        </Variant>
        <Variant label="Dans le fil" note="Une session perdue puis reprise au milieu du travail.">
          <MessagesPreview
            items={[
              notice("session-started"),
              turn("Liste les migrations en attente.", "completed", [text("Aucune migration en attente.")]),
              notice("harness-lost"),
              notice("context-lost"),
              turn("Reprends : relance les tests.", "recorded"),
            ]}
          />
        </Variant>
      </Grid>
    </Section>
  );
}

export function BannerSection() {
  return (
    <Section
      id="bandeaux"
      title="Bandeaux"
      lead="L'état de l'exécution en haut du fil, la raison de fermeture des envois au-dessus du composer, et l'état de la connexion du navigateur au fil."
      binding={
        <>
          Bandeau d'exécution et bandeau de fermeture : à nous, lus depuis le workstream.{" "}
          <code>ConnectionState</code> (registre <code>elements-connection-state</code>) : état du flux dans
          le navigateur, pas une donnée Agora.
        </>
      }
    >
      <Group title="Bandeau d'exécution">
        <Grid cols={3}>
          <Variant label="Démarrage" code="execution: starting">
            <ExecutionBannerView execution="starting" />
          </Variant>
          <Variant label="Erreur" code="execution: error">
            <ExecutionBannerView execution="error" />
          </Variant>
          <Variant label="Arrêtée" code="execution: stopped">
            <ExecutionBannerView execution="stopped" />
          </Variant>
        </Grid>
      </Group>
      <Group title="Fermeture des envois">
        <Grid cols={2}>
          <Variant label="Stockage indisponible" code="isSendDisabled">
            <SendsClosedBannerView reason="Stockage du journal indisponible : les envois reprendront à son retour." />
          </Variant>
          <Variant label="Exécution en démarrage" code="isSendDisabled">
            <SendsClosedBannerView reason="L'exécution démarre : l'envoi ouvrira quand ACP répondra." />
          </Variant>
        </Grid>
      </Group>
      <Group title="Connexion au fil" note="Les quatre phases du composant, avec ses options attempt, resumedTokens et onRetry.">
        <Grid cols={4}>
          <Variant label="En ligne" code='phase="online"' note="Ne rend rien : le composant n'apparaît qu'en cas de problème.">
            <ConnectionState phase="online" />
          </Variant>
          <Variant label="Coupée" code='phase="dropped"'>
            <ConnectionState phase="dropped" onRetry={() => {}} />
          </Variant>
          <Variant label="Reconnexion" code='phase="reconnecting" attempt={2}'>
            <ConnectionState phase="reconnecting" attempt={2} />
          </Variant>
          <Variant label="Reprise" code='phase="resumed" resumedTokens={340}'>
            <ConnectionState phase="resumed" resumedTokens={340} />
          </Variant>
        </Grid>
      </Group>
    </Section>
  );
}

function ComposerPreview({ workstream, running }: { workstream: Workstream; running?: boolean }) {
  const [items, setItems] = useState(running ? [turn(PROMPT, "running" as const)] : []);
  return (
    <AgoraProvider
      workstream={workstream}
      items={items}
      commands={{
        write: (t) => setItems([turn(t, "running")]),
        cancel: () => setItems((all) => all.map((i) => (i.kind === "turn" ? { ...i, state: "cancelled" } : i))),
      }}
    >
      <div className="flex flex-col gap-3" style={THREAD_VARS}>
        <SendsClosedBanner />
        <Composer autoFocus={false} />
      </div>
    </AgoraProvider>
  );
}

export function ComposerSection() {
  return (
    <Section
      id="composer"
      title="Composer"
      lead="La saisie et ses quatre états. Les boutons pièces jointes et dictée du registre sont retirés."
      binding={
        <>
          <code>ComposerPrimitive.Send</code> → <code>onNew</code> → Écrire ;{" "}
          <code>ComposerPrimitive.Cancel</code> → <code>onCancel</code> → Annuler le dernier tour ;{" "}
          <code>isSendDisabled</code> et <code>isDisabled</code> pour les fermetures.
        </>
      }
    >
      <Grid cols={2}>
        <Variant label="Ouvert" note="Envoyer passe le composer en « tour en cours ».">
          <ComposerPreview workstream={WS} />
        </Variant>
        <Variant label="Tour en cours" code="isRunning" note="Le bouton carré annule le tour visé.">
          <ComposerPreview workstream={WS} running />
        </Variant>
        <Variant label="Envois fermés" code="isSendDisabled" note="La saisie reste possible, l'envoi est bloqué.">
          <ComposerPreview workstream={{ ...WS, sendsClosed: "Stockage du journal indisponible : les envois reprendront à son retour." }} />
        </Variant>
        <Variant label="Workstream arrêté" code="isDisabled" note="Plus de saisie du tout.">
          <ComposerPreview workstream={{ ...WS, execution: "stopped" }} />
        </Variant>
      </Grid>
    </Section>
  );
}

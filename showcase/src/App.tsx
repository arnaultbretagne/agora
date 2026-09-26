import { MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { LiveDemo } from "@/showcase/LiveDemo";
import { Section } from "@/showcase/ui";
import {
  BannerSection,
  ComposerSection,
  NoticeSection,
  SidebarSection,
  TurnSection,
} from "@/showcase/sections/ThreadSections";
import {
  DiffSection,
  PermissionSection,
  PlanSection,
  ReasoningSection,
  TerminalSection,
  TextSection,
  ToolSection,
} from "@/showcase/sections/BlockSections";
import { AlternativesSection, CharterSection, OutOfContractSection } from "@/showcase/sections/ExtraSections";

const NAV = [
  { id: "demo", label: "Bout en bout" },
  { id: "barre-laterale", label: "Barre latérale" },
  { id: "tours", label: "Messages et tours" },
  { id: "avis", label: "Avis" },
  { id: "bandeaux", label: "Bandeaux" },
  { id: "texte", label: "Texte" },
  { id: "reflexion", label: "Réflexion" },
  { id: "outils", label: "Outils" },
  { id: "permissions", label: "Permissions" },
  { id: "diff", label: "Diff" },
  { id: "terminal", label: "Terminal" },
  { id: "plan", label: "Plan" },
  { id: "composer", label: "Composer" },
  { id: "hors-contrat", label: "Hors contrat" },
  { id: "alternatives", label: "Alternatives" },
  { id: "charte", label: "Charte" },
];

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const saved = localStorage.getItem("agora-theme");
      if (saved) return saved === "dark";
    } catch {
      /* stockage indisponible : on suit le système */
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("agora-theme", dark ? "dark" : "light");
    } catch {
      /* rien à faire */
    }
  }, [dark]);
  return [dark, setDark] as const;
}

export default function App() {
  const [dark, setDark] = useTheme();
  return (
    <TooltipProvider>
      <header className="bg-background/85 sticky top-0 z-40 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[90rem] items-center gap-3 px-4 sm:px-6">
          <span className="font-heading text-2xl tracking-tight">
            agora<span className="text-primary">.</span>
          </span>
          <span className="text-muted-foreground hidden text-sm sm:inline">banc d'essai de l'interface</span>
          <div className="ms-auto flex items-center gap-2">
            <Badge variant="outline" className="text-muted-foreground hidden font-mono font-normal md:inline-flex">
              @assistant-ui/react 0.15.22
            </Badge>
            <button
              type="button"
              onClick={() => setDark(!dark)}
              className="hover:bg-muted flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs"
              aria-label="Basculer le thème"
            >
              {dark ? <SunIcon className="size-3.5" /> : <MoonIcon className="size-3.5" />}
              {dark ? "Clair" : "Sombre"}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[90rem] gap-8 px-4 sm:px-6 xl:grid-cols-[11rem_minmax(0,1fr)]">
        <nav className="sticky top-20 hidden h-fit py-12 xl:block" aria-label="Sections">
          <ul className="flex flex-col gap-0.5 text-sm">
            {NAV.map((n) => (
              <li key={n.id}>
                <a
                  href={`#${n.id}`}
                  className="text-muted-foreground hover:text-foreground hover:bg-muted block rounded-md px-2 py-1"
                >
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0">
          <div className="border-b pt-12 pb-10">
            <h1 className="font-heading max-w-3xl text-4xl leading-tight tracking-tight sm:text-5xl">
              Chaque composant du contrat, dans chacun de ses états.
            </h1>
            <p className="text-muted-foreground mt-4 max-w-3xl text-[15px] leading-relaxed">
              Cette page rend les vrais composants du registre assistant-ui, adaptés comme le décrit{" "}
              <code className="text-foreground">assistant-ui.md</code>, et branchés sur un faux serveur Agora
              qui tourne dans le navigateur. Chaque section rappelle son branchement, puis montre les options
              côte à côte. Rien ne quitte la page : pas de harness, pas de journal.
            </p>
          </div>

          <Section
            id="demo"
            title="Bout en bout"
            lead="Le Thread et la barre latérale adaptés, sur un fil qui vit. Les contrôles à droite changent ce que le serveur enverrait."
            binding={
              <>
                <code>useExternalStoreRuntime</code> alimenté par les tours et avis du fil ; commandes Écrire,
                Annuler, Répondre à une permission ; <code>adapters.threadList</code> pour la liste.
              </>
            }
          >
            <LiveDemo />
          </Section>
          <SidebarSection />
          <TurnSection />
          <NoticeSection />
          <BannerSection />
          <TextSection />
          <ReasoningSection />
          <ToolSection />
          <PermissionSection />
          <DiffSection />
          <TerminalSection />
          <PlanSection />
          <ComposerSection />
          <OutOfContractSection />
          <AlternativesSection />
          <CharterSection />
          <footer className="text-muted-foreground py-10 text-xs">
            Branche <code>spike/ui-showcase</code> du dépôt agora · contrat <code>assistant-ui.md</code>.
          </footer>
        </main>
      </div>
    </TooltipProvider>
  );
}

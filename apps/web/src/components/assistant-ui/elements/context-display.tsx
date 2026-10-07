"use client";

// assistant-ui's ContextDisplay (registry, elements/context-display, its Ring preset), adapted
// (docs/specs/assistant-ui.md, "Context and limits"): a Popover rather than a Tooltip, so that a touch
// opens it too; the totals only, since ACP gives no breakdown; and, under them, room for what else
// bounds the agent — the account's limits.
import type { FC, ReactNode } from "react";
import { Popover } from "radix-ui";
import { cn } from "@/lib/utils";

type Severity = "normal" | "warning" | "critical";

/** Normal below 65 %, a warning up to 85 %, then critical — the registry's thresholds. */
const severityOf = (percent: number): Severity => (percent > 85 ? "critical" : percent >= 65 ? "warning" : "normal");

const STROKE: Record<Severity, string> = { normal: "stroke-foreground", warning: "stroke-amber-500", critical: "stroke-destructive" };
const BAR: Record<Severity, string> = { normal: "bg-foreground/70", warning: "bg-amber-500", critical: "bg-destructive" };
export const severityText: Record<Severity, string> = { normal: "text-muted-foreground", warning: "text-amber-600 dark:text-amber-500", critical: "text-destructive" };
export { severityOf };

/** A token count, short: "950", "1.2k", "1M". */
export const formatTokens = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(count));
};

/** A thin bar, coloured by how full it is. */
export const Meter: FC<{ percent: number; className?: string }> = ({ percent, className }) => (
  <div className={cn("bg-foreground/10 h-1 overflow-hidden rounded-full", className)}>
    <div
      className={cn("h-full rounded-full transition-[width] duration-300", percent > 0 && "min-w-1", BAR[severityOf(percent)])}
      style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
    />
  </div>
);

const SIZE = 18;
const STROKE_WIDTH = 2.5;
const RADIUS = (SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The registry's ring. */
export const Ring: FC<{ percent: number }> = ({ percent }) => (
  <svg aria-hidden="true" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shrink-0 -rotate-90">
    <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE_WIDTH} className="stroke-foreground/15" />
    <circle
      cx={SIZE / 2}
      cy={SIZE / 2}
      r={RADIUS}
      fill="none"
      strokeWidth={STROKE_WIDTH}
      strokeLinecap="round"
      strokeDasharray={CIRCUMFERENCE}
      strokeDashoffset={CIRCUMFERENCE - (Math.min(100, percent) / 100) * CIRCUMFERENCE}
      className={cn("transition-[stroke-dashoffset,stroke] duration-300", STROKE[severityOf(percent)])}
    />
  </svg>
);

export interface ContextDisplayProps {
  /** The context's tokens in use and its size; none before the agent has said. */
  readonly usage: { readonly used: number; readonly size: number } | null;
  /** What the trigger shows without a context. */
  readonly idle?: ReactNode;
  /** Under the context, in the popover. */
  readonly children?: ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
  readonly className?: string;
}

/** The ring and its percentage; opened, the context's totals, then what `children` adds. */
export const ContextDisplay: FC<ContextDisplayProps> = ({ usage, idle, children, onOpenChange, className }) => {
  if (usage === null && idle === undefined) return null;
  const percent = usage === null ? 0 : Math.min(100, (usage.used / usage.size) * 100);
  return (
    <Popover.Root {...(onOpenChange ? { onOpenChange } : {})}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-slot="context-display-trigger"
          aria-label={usage === null ? "Limits" : "Context usage"}
          className={cn(
            "text-muted-foreground hover:text-foreground rounded-control flex h-7 shrink-0 items-center gap-1.5 px-1.5 text-xs transition-colors pointer-coarse:h-9",
            className,
          )}
        >
          {usage === null ? (
            idle
          ) : (
            <>
              <Ring percent={percent} />
              <span className="font-mono tabular-nums">{Math.round(percent)}%</span>
            </>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          data-slot="context-display-popover"
          className="bg-popover text-popover-foreground border-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 rounded-surface z-50 w-64 border p-3 text-xs"
        >
          {usage !== null && (
            <section aria-label="Context">
              <div className="flex items-baseline justify-between gap-6 whitespace-nowrap">
                <span className={severityText[severityOf(percent)]}>{Math.round(percent)}% of the context</span>
                <span className="font-mono tabular-nums">
                  {formatTokens(Math.min(usage.used, usage.size))} / {formatTokens(usage.size)}
                </span>
              </div>
              <Meter percent={percent} className="mt-2.5" />
            </section>
          )}
          {children !== undefined && children !== null && children !== false && (
            <div className={cn(usage !== null && "border-foreground/10 mt-3 border-t pt-3")}>{children}</div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

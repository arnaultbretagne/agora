"use client";

// assistant-ui's QuestionFlow (registry, elements/question-flow, assistant-ui/assistant-ui at 48b920e, MIT — Tool UI's
// Question Flow as assistant-ui ships it; docs: assistant-ui.com/elements/question-flow), adapted
// (docs/specs/assistant-ui.md, "Forms"):
// - a step's "Other" field, `other`, given to its OptionList, its text answered with the step's options;
// - a step with no options, `input` `text`, `number` or `integer`: a field and Next, a number checked by `fits`;
// - `required`: a step that cannot be left without an answer; any other may be;
// - `onComplete` gives the texts beside the options, `onDecline` refuses the whole flow;
// - the receipt shows each step's text, and a step's own value;
// - React's own `useLayoutEffect`, as surfaces.tsx.
import { useCallback, useId, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { OptionList, useReceiptFocus, type OptionListOption } from "./option-list";
import { field, ghostButton, inkButton, mono, paper } from "./surfaces";

export interface QuestionFlowStep {
  id: string;
  question: string;
  description?: string | undefined;
  options: readonly OptionListOption[];
  selectionMode?: "single" | "multiple" | undefined;
  minSelections?: number | undefined;
  maxSelections?: number | undefined;
  /** Agora's: the free text beside the options. */
  other?: { label: string; placeholder?: string | undefined } | undefined;
  /** Agora's: a step with no options, answered by a field. */
  input?: "text" | "number" | "integer" | undefined;
  /** Agora's: whether a typed value fits the step. */
  fits?: ((typed: string) => boolean) | undefined;
  /** Agora's: a step that must be answered. */
  required?: boolean | undefined;
}

export interface QuestionFlowProps extends Omit<
  ComponentProps<"div">,
  "children" | "defaultValue" | "onSubmit"
> {
  steps: readonly QuestionFlowStep[];
  defaultValue?: Readonly<Record<string, readonly string[]>> | undefined;
  onComplete?:
    | ((answers: Record<string, string[]>, texts: Record<string, string>) => void | Promise<void>)
    | undefined;
  completeLabel?: string | undefined;
  choice?: Readonly<Record<string, readonly string[]>> | undefined;
  /** Agora's: each step's text, in the receipt. */
  choiceTexts?: Readonly<Record<string, string>> | undefined;
  /** Agora's: refuses the whole flow. */
  onDecline?: (() => void | Promise<void>) | undefined;
  declineLabel?: string | undefined;
}

export function QuestionFlow({
  steps,
  defaultValue,
  onComplete,
  completeLabel = "Submit",
  choice,
  choiceTexts,
  onDecline,
  declineLabel = "Decline",
  className,
  ...props
}: QuestionFlowProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    for (const [id, value] of Object.entries(defaultValue ?? {})) {
      initial[id] = [...value];
    }
    return initial;
  });
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState("");
  const [confirmedAnswers, setConfirmedAnswers] = useState<
    { answers: Record<string, string[]>; texts: Record<string, string> } | undefined
  >();
  const [isCompleting, setIsCompleting] = useState(false);
  const questionPrefix = useId();
  const optionListRef = useRef<HTMLDivElement>(null);
  const { receiptRef, focusHandlers } = useReceiptFocus<HTMLDivElement>(props);
  const setReceiptRef = useCallback(
    (node: HTMLDivElement | null) => {
      receiptRef.current = node;
      const { ref } = props;
      if (typeof ref === "function") return ref(node);
      if (ref && typeof ref === "object")
        (ref as { current: HTMLDivElement | null }).current = node;
      return undefined;
    },
    [props.ref, receiptRef],
  );
  const currentIndex = Math.min(stepIndex, Math.max(0, steps.length - 1));
  const currentStep = steps[currentIndex];
  const previousStepId = useRef(currentStep?.id);

  useLayoutEffect(() => {
    if (previousStepId.current === currentStep?.id) return;
    previousStepId.current = currentStep?.id;
    optionListRef.current
      ?.querySelector<HTMLElement>(
        'button:not([disabled]):not([aria-disabled="true"]), input, textarea',
      )
      ?.focus();
  }, [currentStep?.id]);

  const root = cn(
    paper,
    "flex w-full max-w-sm flex-col rounded-2xl p-2",
    className,
  );

  const completedChoice = choice ?? confirmedAnswers?.answers;
  const completedTexts = choiceTexts ?? confirmedAnswers?.texts ?? {};

  if (completedChoice !== undefined) {
    return (
      <div
        {...props}
        {...focusHandlers}
        ref={setReceiptRef}
        tabIndex={-1}
        data-slot="question-flow"
        data-state="receipt"
        className={cn(root, "gap-3")}
      >
        {steps.flatMap((step) => {
          const selected = completedChoice[step.id] ?? [];
          const said = completedTexts[step.id] ?? "";
          if (selected.length === 0 && said === "") return [];
          const labels = step.options
            .filter((option) => selected.includes(option.id))
            .map((option) => option.label)
            .join(", ");
          return (
            <div key={step.id} data-step={step.id} className="flex flex-col gap-0.5 px-2 py-1">
              <span className="text-muted-foreground text-xs leading-4">
                {step.question}
              </span>
              <span className="text-foreground/80 text-[13.5px] leading-5 break-words whitespace-pre-wrap">
                {[labels, said].filter((s) => s !== "").join(" — ")}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  if (!onComplete || !currentStep) {
    return (
      <div
        {...props}
        {...focusHandlers}
        data-slot="question-flow"
        data-state="open"
        className={root}
      />
    );
  }

  const questionId = `${questionPrefix}-${currentStep.id}`;
  const currentAnswer = answers[currentStep.id];
  const finalStep = currentIndex === steps.length - 1;

  const confirm = (ids: string[], text: string) => {
    const nextAnswers = { ...answers, [currentStep.id]: ids };
    const nextTexts = { ...texts, [currentStep.id]: text };
    if (!finalStep) {
      setAnswers(nextAnswers);
      setTexts(nextTexts);
      setTyped(texts[steps[currentIndex + 1]!.id] ?? "");
      setStepIndex(currentIndex + 1);
      return;
    }
    const stepIds = new Set(steps.map((step) => step.id));
    const completedAnswers = Object.fromEntries(
      Object.entries(nextAnswers).filter(([id]) => stepIds.has(id)),
    );
    const completedTexts = Object.fromEntries(
      Object.entries(nextTexts).filter(([id, value]) => stepIds.has(id) && value !== ""),
    );
    setIsCompleting(true);
    try {
      return Promise.resolve(onComplete(completedAnswers, completedTexts)).then(
        () => {
          setAnswers(nextAnswers);
          setConfirmedAnswers({ answers: completedAnswers, texts: completedTexts });
        },
        (error) => {
          setIsCompleting(false);
          throw error;
        },
      );
    } catch (error) {
      setIsCompleting(false);
      return Promise.reject(error);
    }
  };

  const nextLabel = finalStep ? completeLabel : "Next";
  // A field of its own: its value, checked, then Next; left empty when the step allows it.
  const value = typed.trim();
  const canGo = !isCompleting && (value === "" ? currentStep.required !== true : (currentStep.fits?.(value) ?? true));

  return (
    <div
      {...props}
      {...focusHandlers}
      data-slot="question-flow"
      data-state="open"
      className={cn(root, "gap-3")}
    >
      <div className="flex items-center justify-between gap-3 px-2 pt-1">
        <span className={cn(mono, "text-muted-foreground tabular-nums")}>
          {currentIndex + 1} of {steps.length}
        </span>
        <span className="flex items-center gap-1">
          {currentIndex > 0 ? (
            <button
              type="button"
              disabled={isCompleting}
              onClick={() => {
                setTexts({ ...texts, [currentStep.id]: typed });
                setTyped(texts[steps[currentIndex - 1]!.id] ?? "");
                setStepIndex(currentIndex - 1);
              }}
              className={cn(
                ghostButton,
                "h-7 px-2.5 text-xs font-medium",
                isCompleting && "cursor-default opacity-40",
              )}
            >
              Back
            </button>
          ) : null}
          {onDecline ? (
            <button
              type="button"
              disabled={isCompleting}
              onClick={() => {
                setIsCompleting(true);
                void Promise.resolve(onDecline()).catch(() => setIsCompleting(false));
              }}
              className={cn(ghostButton, "h-7 px-2.5 text-xs font-medium", isCompleting && "cursor-default opacity-40")}
            >
              {declineLabel}
            </button>
          ) : null}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={currentIndex + 1}
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuetext={`Question ${currentIndex + 1} of ${steps.length}`}
        className="bg-foreground/[0.08] inset-ring-border mx-2 h-[3px] overflow-hidden rounded-full inset-ring forced-colors:outline"
      >
        <div
          style={{ width: `${((currentIndex + 1) / steps.length) * 100}%` }}
          className="bg-foreground/80 h-full transition-[width] duration-200 forced-color-adjust-none motion-reduce:transition-none"
        />
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        <p id={questionId} className="text-[13.5px] leading-5 font-medium">
          {currentStep.question}
        </p>
        {currentStep.description ? (
          <p className="text-muted-foreground text-xs leading-4">
            {currentStep.description}
          </p>
        ) : null}
      </div>
      <div ref={optionListRef}>
        {currentStep.input ? (
          <div className="flex flex-col gap-2 px-2 pb-1">
            <input
              key={currentStep.id}
              aria-labelledby={questionId}
              value={typed}
              inputMode={currentStep.input === "text" ? "text" : "decimal"}
              onChange={(event) => setTyped(event.target.value)}
              className={cn(field, "rounded-control placeholder:text-muted-foreground h-8 px-2 text-[13px] outline-none")}
            />
            <div className="flex items-center justify-end">
              <button
                type="button"
                aria-disabled={!canGo || undefined}
                onClick={() => {
                  if (canGo) void confirm([], value);
                }}
                className={cn(inkButton, "flex h-8 items-center rounded-full px-3.5 text-xs font-medium", !canGo && "cursor-default opacity-40 hover:opacity-40")}
              >
                {nextLabel}
              </button>
            </div>
          </div>
        ) : (
          <OptionList
            key={currentStep.id}
            aria-labelledby={questionId}
            options={currentStep.options}
            selectionMode={currentStep.selectionMode}
            defaultValue={currentAnswer}
            minSelections={currentStep.minSelections}
            maxSelections={currentStep.maxSelections}
            onConfirm={confirm}
            confirmLabel={nextLabel}
            other={currentStep.other ? { ...currentStep.other, defaultValue: texts[currentStep.id] ?? "" } : undefined}
            className="max-w-none border-0 bg-transparent p-0 dark:bg-transparent"
          />
        )}
      </div>
    </div>
  );
}

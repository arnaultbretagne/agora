"use client";

// assistant-ui's OptionList (registry, elements/option-list, assistant-ui/assistant-ui at 48b920e, MIT — Tool UI's
// Option List as assistant-ui ships it; docs: assistant-ui.com/elements/option-list), adapted (docs/specs/assistant-ui.md,
// "Forms"):
// - an "Other" field, `other`: the free text Claude Code and Codex offer beside a question's options; with it, a single
//   selection waits for the confirm button, which a typed answer alone can open when no option is required;
// - `onDecline`: a form can be refused, a button at the foot;
// - `choiceText`: the receipt shows the text given with the options;
// - the receipt is `choice` alone, the host's state: once `onConfirm` settles, the list stays held until it comes; a
//   rejected `onConfirm` gives the list back, its error said;
// - `useReceiptFocus` and `clamp` inlined; React's own `useLayoutEffect`, as surfaces.tsx.
import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { field, ghostButton, inkButton, mono, paper } from "./surfaces";

export interface OptionListOption {
  id: string;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
}

export interface OptionListProps extends Omit<
  ComponentProps<"div">,
  "children" | "defaultValue" | "onChange"
> {
  options: readonly OptionListOption[];
  /** One option answers the question, or several do. */
  selectionMode?: "single" | "multiple" | undefined;
  /**
   * Options the list starts selected: checked in a multiple selection, and
   * marked as the current answer in a single one.
   */
  defaultValue?: readonly string[] | undefined;
  /** The fewest options a multiple selection confirms with. */
  minSelections?: number | undefined;
  /** The most options a multiple selection may hold. */
  maxSelections?: number | undefined;
  /**
   * Commits the answer: a single selection commits on pick, a multiple one on
   * the confirm button. Without it the list only displays its options. A
   * rejected promise reopens the list, because the answer never landed.
   */
  onConfirm?: ((ids: string[], text: string) => void | Promise<void>) | undefined;
  confirmLabel?: string | undefined;
  /**
   * The committed answer. Once set, the list is a receipt of just these
   * options and takes no further input.
   */
  choice?: readonly string[] | undefined;
  /** Agora's: the free text beside the options, its label and what it starts with. */
  other?: { label: string; placeholder?: string | undefined; defaultValue?: string | undefined } | undefined;
  /** Agora's: the text given with the choice, in its receipt. */
  choiceText?: string | undefined;
  /** Agora's: refuses the question. */
  onDecline?: (() => void | Promise<void>) | undefined;
  declineLabel?: string | undefined;
}

const row =
  "flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-start transition-colors outline-none focus-visible:ring-1 focus-visible:ring-foreground/20";

const clamp = (value: number, min: number, max: number) => (Number.isNaN(value) ? min : Math.min(max, Math.max(min, value)));

/** Focus kept on the receipt when the control that had it goes (assistant-ui's receipt-focus). */
function useReceiptFocus<T extends HTMLElement>(handlers: Pick<ComponentProps<"div">, "onFocusCapture" | "onBlurCapture"> = {}) {
  const focusedElementRef = useRef<HTMLElement | null>(null);
  const receiptRef = useRef<T | null>(null);
  useLayoutEffect(() => {
    const focusedElement = focusedElementRef.current;
    if (focusedElement && !focusedElement.isConnected) {
      focusedElementRef.current = null;
      if (focusedElement.ownerDocument.activeElement === focusedElement.ownerDocument.body) receiptRef.current?.focus({ preventScroll: true });
    }
  });
  return {
    receiptRef,
    focusHandlers: {
      onFocusCapture: (event) => {
        handlers.onFocusCapture?.(event);
        focusedElementRef.current = event.target as HTMLElement;
      },
      onBlurCapture: (event) => {
        handlers.onBlurCapture?.(event);
        if (event.target.isConnected && !event.currentTarget.contains(event.relatedTarget ?? event.currentTarget.ownerDocument.activeElement)) focusedElementRef.current = null;
      },
    } satisfies Pick<ComponentProps<"div">, "onFocusCapture" | "onBlurCapture">,
  };
}
export { useReceiptFocus };

function OptionText({ option }: { option: OptionListOption }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-[13.5px] leading-5 break-words">
        {option.label}
      </span>
      {option.description ? (
        <span className="text-muted-foreground text-xs leading-4 break-words">
          {option.description}
        </span>
      ) : null}
    </span>
  );
}

export function OptionList({
  options,
  selectionMode = "single",
  defaultValue,
  minSelections = 1,
  maxSelections,
  onConfirm,
  confirmLabel = "Confirm",
  choice,
  other,
  choiceText,
  onDecline,
  declineLabel = "Decline",
  className,
  ...props
}: OptionListProps) {
  const multiple = selectionMode === "multiple";
  const [selected, setSelected] = useState<readonly string[]>(() =>
    (defaultValue ?? []).filter((id) => options.some((o) => o.id === id)),
  );
  const [typed, setTyped] = useState(other?.defaultValue ?? "");
  const [pending, setPending] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  const root = cn(
    paper,
    "flex w-full max-w-sm flex-col gap-1 rounded-2xl p-2",
    className,
  );

  if (choice !== undefined) {
    const chosen = options.filter((option) => choice.includes(option.id));
    const said = choiceText ?? "";
    return (
      <div
        data-slot="option-list"
        data-state="receipt"
        className={root}
        {...props}
        {...focusHandlers}
        ref={setReceiptRef}
        tabIndex={-1}
      >
        {chosen.length === 0 && said === "" ? (
          <span className={cn(mono, "text-muted-foreground px-2 py-2")}>
            Nothing selected
          </span>
        ) : (
          chosen.map((option) => (
            <div key={option.id} className={cn(row, "text-foreground/70")}>
              <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
                <CheckIcon
                  aria-hidden
                  className="text-muted-foreground size-3.5"
                />
                <span className="sr-only">Selected:</span>
              </span>
              <OptionText option={option} />
            </div>
          ))
        )}
        {said !== "" ? (
          <p data-other className="text-foreground/70 px-2 py-1 text-[13.5px] leading-5 break-words whitespace-pre-wrap">
            <span className="text-muted-foreground">{other?.label ?? "Other"}: </span>
            {said}
          </p>
        ) : null}
      </div>
    );
  }

  if (!onConfirm) {
    return (
      <div
        data-slot="option-list"
        className={root}
        {...props}
        {...focusHandlers}
      >
        {options.map((option) => (
          <div
            key={option.id}
            className={cn(row, option.disabled && "text-muted-foreground")}
          >
            <OptionText option={option} />
          </div>
        ))}
      </div>
    );
  }

  const locked = pending !== null;
  const max = Math.floor(
    clamp(maxSelections ?? options.length, 0, options.length),
  );
  const min = Math.floor(clamp(minSelections, 0, max));
  const optionIds = new Set(options.map((option) => option.id));
  const selectedIds = selected.filter((id) => optionIds.has(id));
  // With an "Other" field, a single selection waits for the button: the text goes with it.
  const confirming = multiple || other !== undefined;

  const commit = (ids: string[]) => {
    if (locked) return;
    setPending(ids);
    setError(null);
    void (async () => {
      try {
        // Held until the host gives its `choice`.
        await onConfirm(ids, typed.trim());
      } catch (commitError) {
        setPending(null);
        setError(
          commitError instanceof Error
            ? commitError.message
            : String(commitError),
        );
      }
    })();
  };

  const toggle = (id: string) => {
    if (locked) return;
    setSelected((current) => {
      const available = current.filter((value) => optionIds.has(value));
      if (!multiple) return available.includes(id) ? [] : [id];
      return available.includes(id)
        ? available.filter((value) => value !== id)
        : available.length < max
          ? [...available, id]
          : available;
    });
  };

  const count = selectedIds.length;
  // As many options as it asks; none, where it asks none — a typed answer alone, or nothing, as a question left blank.
  const canConfirm = !locked && count <= max && (min === 0 || count >= min);

  return (
    <div
      role="group"
      data-slot="option-list"
      data-state={locked ? "pending" : "open"}
      aria-busy={locked || undefined}
      className={root}
      {...props}
      {...focusHandlers}
    >
      {options.map((option) => {
        const isSelected = confirming
          ? selectedIds.includes(option.id)
          : (pending ?? selected).includes(option.id);
        const unavailable =
          option.disabled === true || (multiple && !isSelected && count >= max);
        return (
          <button
            key={option.id}
            type="button"
            {...(multiple
              ? { role: "checkbox", "aria-checked": isSelected }
              : confirming
                ? { role: "radio", "aria-checked": isSelected }
                : {})}
            aria-disabled={unavailable || locked || undefined}
            disabled={option.disabled}
            onClick={() => {
              if (unavailable) return;
              if (confirming) toggle(option.id);
              else commit([option.id]);
            }}
            className={cn(
              row,
              isSelected
                ? "bg-foreground/[0.06]"
                : !unavailable && !locked && "hover:bg-foreground/[0.035]",
              unavailable ? "text-muted-foreground" : "text-foreground/90",
              (unavailable || locked) && "cursor-default",
            )}
          >
            {confirming ? (
              <span
                aria-hidden
                className="flex h-5 w-3.5 shrink-0 items-center justify-center"
              >
                <span
                  className={cn(
                    "flex size-3.5 items-center justify-center border transition-colors",
                    multiple ? "rounded-[5px]" : "rounded-full",
                    isSelected
                      ? "border-foreground bg-foreground"
                      : "border-foreground/15",
                  )}
                >
                  {isSelected ? (
                    <CheckIcon className="fade-in zoom-in-90 animate-in text-background size-2.5 duration-200 motion-reduce:animate-none" />
                  ) : null}
                </span>
              </span>
            ) : pending?.includes(option.id) ? (
              <span
                aria-hidden
                className="flex h-5 w-3.5 shrink-0 items-center justify-center"
              >
                <Loader2Icon className="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none" />
              </span>
            ) : null}
            <OptionText option={option} />
          </button>
        );
      })}
      {other ? (
        <label className="flex flex-col gap-1 px-2 pt-1">
          <span className="text-muted-foreground text-xs leading-4">{other.label}</span>
          <textarea
            value={typed}
            disabled={locked}
            rows={1}
            placeholder={other.placeholder}
            onChange={(event) => setTyped(event.target.value)}
            className={cn(field, "rounded-control placeholder:text-muted-foreground resize-y px-2 py-1.5 text-[13px] outline-none")}
          />
        </label>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="px-2 pb-1 text-xs break-words text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
      {confirming || onDecline ? (
        <div className="flex items-center justify-between gap-3 px-2 pt-1.5 pb-1">
          {multiple ? (
            <span className={cn(mono, "text-muted-foreground tabular-nums")}>
              {count} of {max}
            </span>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-1.5">
            {onDecline ? (
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  if (locked) return;
                  setPending([]);
                  setError(null);
                  void Promise.resolve(onDecline()).catch((declineError: unknown) => {
                    setPending(null);
                    setError(declineError instanceof Error ? declineError.message : String(declineError));
                  });
                }}
                className={cn(ghostButton, "h-8 px-3 text-xs font-medium", locked && "cursor-default opacity-40")}
              >
                {declineLabel}
              </button>
            ) : null}
            {confirming ? (
              <button
                type="button"
                aria-disabled={!canConfirm || undefined}
                onClick={() => {
                  if (!canConfirm) return;
                  commit(
                    options
                      .filter((option) => selectedIds.includes(option.id))
                      .map((option) => option.id),
                  );
                }}
                className={cn(
                  inkButton,
                  "flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium",
                  !canConfirm && "cursor-default opacity-40 hover:opacity-40",
                )}
              >
                {locked ? (
                  <Loader2Icon
                    aria-hidden
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                  />
                ) : null}
                {confirmLabel}
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}

"use client";

// assistant-ui's Attachment (registry, elements/attachment), adapted (docs/specs/assistant-ui.md,
// "Attachments"): a Radix dialog and a plain image instead of shadcn's dialog and avatar; a file shown
// by its icon and its name, readable on a touch screen, where a tooltip never opens; no upload state,
// since Agora prepares each file before it is attached and refuses it otherwise.
import { useEffect, useState, type FC } from "react";
import { FileTextIcon, PaperclipIcon, XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { cn } from "@/lib/utils";

/** The image's address: its file's while in the composer, its content's once sent. */
const useAttachmentSrc = (): string | undefined => {
  const isImage = useAuiState((s) => s.attachment.type === "image");
  const file = useAuiState((s) => (s.attachment.type === "image" ? s.attachment.file : undefined));
  const src = useAuiState((s) => (s.attachment.type === "image" ? s.attachment.content?.find((c) => c.type === "image")?.image : undefined));
  const [url, setUrl] = useState<{ file: File; url: string }>();
  useEffect(() => {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl({ file, url: objectUrl });
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  if (!isImage) return undefined;
  return (url !== undefined && url.file === file ? url.url : undefined) ?? src;
};

const tile =
  "bg-muted relative overflow-hidden rounded-control after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/10 after:ring-inset dark:after:ring-white/10";

const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";
  const src = useAttachmentSrc();
  const name = useAuiState((s) => s.attachment.name);
  return (
    <AttachmentPrimitive.Root className={cn("relative shrink-0", isComposer && "animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none")} title={name}>
      {src ? (
        <Dialog.Root>
          <Dialog.Trigger asChild>
            <button
              type="button"
              aria-label={`Preview ${name}`}
              className={cn(tile, "block cursor-zoom-in active:scale-[0.96]", isComposer ? "size-14" : "size-20")}
            >
              <img src={src} alt="" className="size-full object-cover" />
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/60" />
            <Dialog.Content
              aria-describedby={undefined}
              className="bg-background rounded-surface fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[min(56rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 items-center justify-center p-2"
            >
              <Dialog.Title className="sr-only">Preview {name}</Dialog.Title>
              <img src={src} alt={name} className="block max-h-[calc(90dvh-1rem)] w-auto max-w-full rounded-sm object-contain" />
              <Dialog.Close aria-label="Close" className="bg-foreground/60 text-background hover:bg-foreground/80 absolute top-3 right-3 grid size-7 place-items-center rounded-full">
                <XIcon className="size-4" />
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : (
        <div className={cn(tile, "flex h-14 max-w-48 items-center gap-2 px-3 text-[13px]", isComposer && "pe-8")}>
          <FileTextIcon className="text-muted-foreground size-5 shrink-0 stroke-[1.5]" />
          <span className="truncate">{name}</span>
        </div>
      )}
      {isComposer && (
        <AttachmentPrimitive.Remove
          aria-label={`Remove ${name}`}
          className="absolute end-1 top-1 grid size-5 place-items-center rounded-full bg-black/50 text-white after:absolute after:-inset-1.5 hover:bg-black/70 pointer-coarse:size-6"
        >
          <XIcon className="size-3 stroke-[2.5]" />
        </AttachmentPrimitive.Remove>
      )}
    </AttachmentPrimitive.Root>
  );
};

/** A user message's attachments, above its bubble. */
export const UserMessageAttachments: FC = () => (
  <div className="mb-2 flex w-full max-w-[80%] flex-row flex-wrap justify-end gap-2 empty:hidden">
    <MessagePrimitive.Attachments>{() => <AttachmentUI />}</MessagePrimitive.Attachments>
  </div>
);

/** The composer's attachments, above its text. */
export const ComposerAttachments: FC = () => (
  <div className="flex w-full flex-row items-center gap-2 overflow-x-auto px-3 pt-3 empty:hidden">
    <ComposerPrimitive.Attachments>{() => <AttachmentUI />}</ComposerPrimitive.Attachments>
  </div>
);

/** The paperclip: the device's file picker, several files at once. */
export const ComposerAddAttachment: FC<{ className?: string }> = ({ className }) => (
  <ComposerPrimitive.AddAttachment aria-label="Attach files" title="Attach files" className={className}>
    <PaperclipIcon className="size-4" />
  </ComposerPrimitive.AddAttachment>
);

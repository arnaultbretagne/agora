// Markdown that is no message's own text (docs/specs/assistant-ui.md, "A tool's line", "Messages"): an approval's
// proposal, a report's text — set close to the agent's messages, a size smaller.
import type { FC } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export const Markdown: FC<{ text: string }> = ({ text }) => (
  <div className="text-[14px] leading-relaxed wrap-break-word [&_a]:underline [&_blockquote]:border-foreground/15 [&_blockquote]:text-muted-foreground [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:font-mono [&_code]:text-[12px] [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_pre]:bg-code [&_pre]:border-foreground/10 [&_pre]:rounded-surface [&_pre]:my-1.5 [&_pre]:overflow-auto [&_pre]:border [&_pre]:px-3 [&_pre]:py-2 [&_ul]:list-disc [&_ul]:pl-5 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
  </div>
)

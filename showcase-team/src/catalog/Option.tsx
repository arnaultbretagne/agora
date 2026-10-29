// One option for one need: what it is (name, kind, registry item, docs), the element rendered as
// is, and what it gives and lacks for a team. ★ marks the suggested one.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type Kind = 'bound' | 'props' | 'agora'

const KIND: Record<Kind, { label: string; tone: string; title: string }> = {
  bound: { label: 'runtime-bound', tone: 'bg-blue-500/10 text-blue-700 dark:text-blue-300', title: 'Renders from the tool call in the runtime (args, approval, nested messages, status): no props to pass.' },
  props: { label: 'presentational', tone: 'bg-foreground/[0.06] text-foreground/80', title: 'Takes props: Agora maps its data onto them.' },
  agora: { label: 'Agora, not assistant-ui', tone: 'bg-primary/12 text-primary', title: 'Agora’s own client already has it.' },
}

export function Option({
  name,
  kind,
  item,
  doc,
  star,
  gives,
  lacks,
  children,
  wide,
}: {
  name: string
  kind: Kind
  item?: string
  doc?: string
  star?: boolean
  gives: string
  lacks: string
  children: ReactNode
  wide?: boolean
}) {
  const k = KIND[kind]
  return (
    <figure className={cn('m-0 flex min-w-0 flex-col rounded-xl border', star ? 'border-primary/50' : 'border-border', wide && 'md:col-span-2')}>
      <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3.5 py-2.5 text-[13px]">
        <span className="font-semibold">{star && <span className="text-primary">★ </span>}{name}</span>
        <span title={k.title} className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', k.tone)}>{k.label}</span>
        {item && <code className="text-muted-foreground font-mono text-[11px]">{item}</code>}
        {doc && (
          <a className="text-muted-foreground hover:text-foreground ml-auto text-[12px] underline underline-offset-2" href={`https://www.assistant-ui.com${doc}`} target="_blank" rel="noreferrer">
            docs ↗
          </a>
        )}
      </figcaption>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-3 p-3.5">{children}</div>
      <div className="border-t px-3.5 py-2.5 text-[12.5px] leading-relaxed">
        <p className="m-0"><span className="text-success font-semibold">+ </span>{gives}</p>
        <p className="m-0"><span className="text-destructive font-semibold">− </span>{lacks}</p>
      </div>
    </figure>
  )
}

export function Need({ id, title, mechanism, children }: { id: string; title: string; mechanism: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-4 scroll-mt-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-brand m-0 text-2xl font-medium">{title}</h2>
        <p className="text-muted-foreground m-0 max-w-3xl text-[14px] leading-relaxed">{mechanism}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </section>
  )
}

/** A label above one state of an element, when a frame shows two. */
export function State({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <span className="text-muted-foreground font-mono text-[11px] uppercase tracking-wide">{label}</span>
      {children}
    </div>
  )
}

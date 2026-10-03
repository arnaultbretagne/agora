// The screen (docs/specs/assistant-ui.md, "The screen"): the Workstreams on the left, the one open on
// the right. Its address is /w/<id>, so that a reload or a link opens it again.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Thread } from '@/components/assistant-ui/elements/thread.aui'
import { ThreadList } from '@/components/assistant-ui/elements/thread-list.aui'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Api } from './agora/api.ts'
import { AgoraComposer, AgoraTool, ComposerBanner, Header, Notice, PlanUI, TurnBadge } from './agora/components.tsx'
import { AgoraProvider } from './agora/runtime.tsx'

const fromPath = (): string | null => /^\/w\/([0-9a-f-]{36})$/.exec(location.pathname)?.[1] ?? null

export function App() {
  const api = useMemo(() => new Api(), [])
  const [id, setId] = useState<string | null>(fromPath)
  useEffect(() => {
    const back = () => setId(fromPath())
    addEventListener('popstate', back)
    return () => removeEventListener('popstate', back)
  }, [])
  const open = useCallback((next: string) => {
    if (fromPath() !== next) history.pushState(null, '', `/w/${next}`)
    setId(next)
  }, [])
  return (
    <TooltipProvider>
      <AgoraProvider api={api} id={id} onOpen={open}>
        <PlanUI />
        <div className="flex h-dvh">
          <aside className="bg-muted/30 flex w-72 shrink-0 flex-col border-r p-2">
            <div className="px-2 py-3 font-medium">Agora</div>
            <ThreadList />
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            {id === null ? (
              <div className="text-muted-foreground m-auto text-sm">Open a workstream, or start a new one.</div>
            ) : (
              <>
                <Header />
                <div className="min-h-0 flex-1">
                  <Thread
                    key={id}
                    components={{ Notice, UserBadge: TurnBadge, BeforeComposer: ComposerBanner, Composer: AgoraComposer, ToolFallback: AgoraTool }}
                  />
                </div>
              </>
            )}
          </main>
        </div>
      </AgoraProvider>
    </TooltipProvider>
  )
}

// The screen (docs/specs/assistant-ui.md, "The screen"): a new Workstream's draft at /, an open one at
// /w/<id>, so that a reload or a link opens it again.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Api } from './agora/api.ts'
import { AgoraProvider } from './agora/runtime.tsx'
import { Shell } from './screen/shell.tsx'

const fromPath = (): string | null => /^\/w\/([0-9a-f-]{36})$/.exec(location.pathname)?.[1] ?? null

export function App() {
  const api = useMemo(() => new Api(), [])
  const [id, setId] = useState<string | null>(fromPath)
  useEffect(() => {
    const back = () => setId(fromPath())
    addEventListener('popstate', back)
    return () => removeEventListener('popstate', back)
  }, [])
  const open = useCallback((next: string | null) => {
    const path = next === null ? '/' : `/w/${next}`
    if (location.pathname !== path) history.pushState(null, '', path)
    setId(next)
  }, [])
  return (
    <TooltipProvider>
      <AgoraProvider api={api} id={id} onOpen={open}>
        <Shell />
      </AgoraProvider>
    </TooltipProvider>
  )
}

// React's side of the exchanges (docs/specs/assistant-ui.md, "The exchanges"): the Workstream list,
// read again every 10 seconds and whenever asked; a Workstream's thread, kept in the browser with its
// cursor — reused only together — and read again from that cursor.
import { useCallback, useEffect, useState } from 'react'
import type { Api } from './api.ts'
import { empty, type ThreadState, type ViewObject } from './objects.ts'
import { ThreadStream, type Connection } from './stream.ts'
import type { WorkstreamView } from './view.ts'

export function useWorkstreams(api: Api): { workstreams: WorkstreamView[]; loading: boolean; reload: () => void } {
  const [workstreams, setWorkstreams] = useState<WorkstreamView[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])
  useEffect(() => {
    let live = true
    void api
      .workstreams()
      .then((list) => live && setWorkstreams(list))
      .catch(() => undefined)
      .finally(() => live && setLoading(false))
    const timer = setTimeout(reload, 10_000)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, tick, reload])
  return { workstreams, loading, reload }
}

const KEY = (id: string) => `agora:thread:${id}`

function stored(id: string): ThreadState {
  try {
    const raw = localStorage.getItem(KEY(id))
    if (raw === null) return empty
    const saved = JSON.parse(raw) as { cursor: string; objects: ViewObject[] }
    BigInt(saved.cursor)
    return { cursor: saved.cursor, objects: new Map(saved.objects.map((o) => [o.id, o])), complete: false }
  } catch {
    return empty
  }
}

function store(id: string, state: ThreadState): void {
  try {
    localStorage.setItem(KEY(id), JSON.stringify({ cursor: state.cursor, objects: [...state.objects.values()] }))
  } catch {
    // A full or refused storage: the next read starts from zero.
  }
}

export function useThread(api: Api, id: string | null): { state: ThreadState; connection: Connection } {
  const [state, setState] = useState<ThreadState>(empty)
  const [connection, setConnection] = useState<Connection>('connecting')
  useEffect(() => {
    if (id === null) return
    const initial = stored(id)
    setState(initial)
    let saved = initial.cursor
    let timer: ReturnType<typeof setTimeout> | undefined
    const stream = new ThreadStream(initial, {
      url: (cursor) => api.threadUrl(id, cursor),
      onChange: (next, phase) => {
        setState(next)
        setConnection(phase)
        // The cursor is stored with the objects it belongs to, at most twice a second.
        if (next.complete && next.cursor !== saved && timer === undefined)
          timer = setTimeout(() => {
            timer = undefined
            saved = stream.current.cursor
            if (stream.current.complete) store(id, stream.current)
          }, 500)
      },
    })
    stream.start()
    return () => {
      stream.stop()
      if (timer !== undefined) clearTimeout(timer)
      if (stream.current.complete) store(id, stream.current)
    }
  }, [api, id])
  return { state, connection }
}

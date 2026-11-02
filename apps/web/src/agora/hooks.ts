// React's side of the exchanges (docs/specs/assistant-ui.md, "The exchanges"): a list, read as the thread
// is, its older rows a page at a time, a search on the server; a Workstream's thread, kept in the browser
// with its cursor — reused only together — and read again from that cursor.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Api, Folder, Hit, Page } from './api.ts'
import { empty, type ThreadState, type ViewObject } from './objects.ts'
import { ThreadStream, type Connection } from './stream.ts'
import { merged, type ListRow } from './view.ts'

/** A list as the sidebar shows it: its rows, newest first, and the way to the older ones. */
export interface ListFeed {
  readonly rows: readonly ListRow[]
  /** Reads the next page of older rows, unless one is being read or none is left. */
  readonly more: () => void
  /** Whether no older row is left to read. */
  readonly end: boolean
}

/** The rows a page holds, newest first, as the server sends them. */
const PAGE = 50

/** The pages read below a list's first rows: their rows, the next one's cursor, and whether it is known yet. */
interface Older {
  readonly rows: readonly ListRow[]
  readonly next: string | null
  readonly known: boolean
}

const UNKNOWN: Older = { rows: [], next: null, known: false }

const rowsOf = (state: ThreadState): ListRow[] => [...state.objects.values()].map((o) => o.object as unknown as ListRow)

/** A page read once at a time; a page for a cursor no longer wanted is dropped. */
function usePages(api: Api, folder: Folder | null, title: string, older: Older, onPage: (at: string, page: Page) => void, parent: string | null = null): () => void {
  const reading = useRef(false)
  return useCallback(() => {
    const at = older.next
    if (reading.current || at === null) return
    reading.current = true
    void api
      .page(folder, at, title, parent)
      .then((page) => onPage(at, page), () => undefined)
      .finally(() => (reading.current = false))
  }, [api, folder, title, older.next, onPage, parent])
}

/**
 * A list of the person's (docs/specs/assistant-ui.md, "The exchanges"), one of their folders', or a
 * Workstream's sub-streams: its most recent rows then each change, read as the thread is and never
 * fetched again whole; below them, the older rows a page at a time.
 */
export function useList(api: Api, folder: Folder | null = null, enabled = true, parent: string | null = null): ListFeed {
  const [state, setState] = useState<ThreadState>(empty)
  const [older, setOlder] = useState<Older>(UNKNOWN)
  useEffect(() => {
    setState(empty)
    setOlder(UNKNOWN)
    if (!enabled) return
    let first = true
    const stream = new ThreadStream(empty, {
      url: (cursor) => api.listUrl(folder, cursor, parent),
      onChange: (next) => {
        setState(next)
        // Below the first snapshot's oldest row, the older pages; none below fewer than a page. A row read
        // twice — the snapshot read again after a break — only comes back in a page, once in the list.
        if (first && next.complete) {
          first = false
          const oldest = merged(rowsOf(next)).at(-1)
          setOlder({ rows: [], next: next.objects.size < PAGE || !oldest ? null : `${oldest.changedAt ?? ''},${oldest.id}`, known: true })
        }
      },
    })
    stream.start()
    return () => stream.stop()
  }, [api, folder, enabled, parent])
  const onPage = useCallback((at: string, page: Page) => setOlder((o) => (o.next === at ? { rows: [...o.rows, ...page.rows], next: page.next, known: true } : o)), [])
  const more = usePages(api, folder, '', older, onPage, parent)
  const rows = useMemo(() => merged(rowsOf(state), older.rows), [state, older.rows])
  return { rows, more, end: older.known && older.next === null }
}

/**
 * The rows of a list whose title holds a text (docs/specs/assistant-ui.md, "Sidebar"), from every page:
 * read from the server 250 ms after the last key, a page at a time; null while the text is empty. Until
 * the text's first page comes, the last text's rows stay, for the screen to filter.
 */
export function useSearch(api: Api, folder: Folder | null, text: string, enabled = true): (ListFeed & { readonly text: string }) | null {
  const wanted = text.trim()
  const [found, setFound] = useState<{ text: string; older: Older } | null>(null)
  useEffect(() => {
    if (!enabled || wanted === '') return setFound(null)
    let live = true
    const timer = setTimeout(() => {
      void api.page(folder, null, wanted).then(
        (page) => live && setFound({ text: wanted, older: { rows: page.rows, next: page.next, known: true } }),
        () => undefined,
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, folder, wanted, enabled])
  const older = found?.older ?? UNKNOWN
  const onPage = useCallback(
    (at: string, page: Page) =>
      setFound((f) => (f && f.older.next === at ? { text: f.text, older: { rows: [...f.older.rows, ...page.rows], next: page.next, known: true } } : f)),
    [],
  )
  const more = usePages(api, folder, found?.text ?? '', older, onPage)
  if (wanted === '' || found === null) return null
  return { text: found.text, rows: found.older.rows, more, end: found.older.next === null }
}

/**
 * The Workstreams whose exchanges hold a text (docs/specs/assistant-ui.md, "Sidebar"; docs/specs/search.md),
 * asked 250 ms after the last key; null while the text is empty. Until the text's answer comes, the last
 * text's stays, for the screen to wait on.
 */
export function useWords(api: Api, text: string): { readonly text: string; readonly hits: readonly Hit[] } | null {
  const wanted = text.trim()
  const [found, setFound] = useState<{ text: string; hits: readonly Hit[] } | null>(null)
  useEffect(() => {
    if (wanted === '') return setFound(null)
    let live = true
    const timer = setTimeout(() => {
      void api.search(wanted).then(
        (hits) => live && setFound({ text: wanted, hits }),
        () => live && setFound({ text: wanted, hits: [] }),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, wanted])
  return wanted === '' ? null : found
}

/**
 * The open Workstream's parents, its root first (docs/specs/assistant-ui.md, "Header"): its row, then each
 * parent's, read one at a time; none for a root.
 */
export function useLine(api: Api, id: string | null): readonly ListRow[] {
  const [line, setLine] = useState<readonly ListRow[]>([])
  useEffect(() => {
    setLine([])
    if (id === null) return
    let live = true
    void (async () => {
      const up: ListRow[] = []
      let row = await api.row(id)
      while (live && row?.parent) {
        const parent: ListRow | null = await api.row(row.parent)
        if (parent === null) break
        up.unshift(parent)
        row = parent
      }
      if (live) setLine(up)
    })().catch(() => undefined)
    return () => {
      live = false
    }
  }, [api, id])
  return line
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
    // A draft has no thread: nothing of the Workstream left behind stays on screen.
    if (id === null) {
      setState(empty)
      setConnection('connected')
      return
    }
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

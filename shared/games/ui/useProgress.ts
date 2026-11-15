import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createGamesClient, GamesHttpError, isConflict, type GamesRequest } from '../core/client'
import { EMPTY_STATE, itemOf, type ProgressState, type SessionResult } from '../core/progress'
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings, type GamesSettings } from '../core/settings'
import { newId } from '../core/uid'
import { openOutbox, type Outbox } from '../data/outbox'
import { flushOutbox, recordSession } from '../data/sync'

export type LoadStatus = 'loading' | 'ready' | 'offline' | 'unavailable'

/** Loads progress, keeps the offline outbox flushed, and saves settings and finished sessions. */
export function useProgress(request: GamesRequest) {
  const client = useMemo(() => createGamesClient(request), [request])
  const [state, setState] = useState<ProgressState>(EMPTY_STATE)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [pending, setPending] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const outbox = useRef<Promise<Outbox> | null>(null)
  const getOutbox = useCallback(() => outbox.current ?? (outbox.current = openOutbox()), [])
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    try {
      const box = await getOutbox()
      const report = await flushOutbox(box, client).catch(error => ({ error, sent: 0, dropped: 0, pending: 1, rejected: [] as string[], state: undefined }))
      if (!alive.current) return
      setPending(report.pending)
      if (report.rejected.length) setNotice(`${report.rejected.length} saved session(s) were refused by the server and discarded.`)
      const fresh = report.state ?? await client.getState()
      if (!alive.current) return
      setState(fresh)
      setStatus('ready')
    } catch (error) {
      if (!alive.current) return
      if (error instanceof GamesHttpError && (error.status === 404 || error.status === 405)) setStatus('unavailable')
      else setStatus(current => (current === 'ready' ? 'ready' : 'offline'))
    }
  }, [client, getOutbox])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const retry = () => void load()
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [load])

  const record = useCallback(async (session: SessionResult) => {
    const box = await getOutbox()
    const report = await recordSession(box, client, session)
    if (!alive.current) return
    setPending(report.pending)
    if (report.state) { setState(report.state); setStatus('ready') }
  }, [client, getOutbox])

  const saveSettings = useCallback(async (next: GamesSettings) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = attempt === 0 ? state : await client.getState()
      try {
        const item = { ...itemOf(base.profile), settings: mergeSettings(base.profile?.settings, next), version: 1 }
        await client.putState({ mutation_id: newId(), profile: { revision: base.profile?.revision ?? 0, item } })
        const fresh = await client.getState()
        if (alive.current) setState(fresh)
        return
      } catch (error) {
        if (isConflict(error) && attempt < 2) continue
        throw error
      }
    }
  }, [client, state])

  const settings = useMemo(() => normalizeSettings(state.profile?.settings ?? DEFAULT_SETTINGS), [state.profile])
  return { state, status, pending, notice, dismissNotice: () => setNotice(null), settings, saveSettings, record, reload: load }
}

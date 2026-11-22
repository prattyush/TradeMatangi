import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalSession } from '../core/dashboard'
import { openSessionLog, type SessionLog } from '../data/sessionLog'

/** The sessions kept on this device (trend panels and Review). Loads once, adds as sessions finish. */
export function useSessionLog() {
  const log = useRef<Promise<SessionLog> | null>(null)
  const getLog = useCallback(() => log.current ?? (log.current = openSessionLog()), [])
  const [sessions, setSessions] = useState<LocalSession[]>([])
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refresh = useCallback(async () => {
    try {
      const list = await (await getLog()).list()
      if (alive.current) setSessions(list)
    } catch { /* an unreadable log only means no trends and no Review */ }
  }, [getLog])
  useEffect(() => { void refresh() }, [refresh])
  const add = useCallback(async (entry: LocalSession) => {
    try { await (await getLog()).add(entry); await refresh() } catch { /* same */ }
  }, [getLog, refresh])
  return { sessions, add }
}

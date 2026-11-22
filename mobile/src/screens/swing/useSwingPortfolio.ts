import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isMissingEndpoint, isForbidden, describeError } from '../../api/errors'
import { isAbort } from '../../api/transport'
import { useServices } from '../../app/AppContext'
import { createSwingApi, followPortfolio, type SwingApi } from './swingApi'
import type { Broker, Capabilities, Snapshot, SwingMode } from './swingTypes'

export type SwingStatus = 'loading' | 'ready' | 'error' | 'unavailable'

export interface SwingPortfolioState {
  api: SwingApi
  status: SwingStatus
  error: string | null
  snapshot: Snapshot | null
  capabilities: Capabilities | null
  /** The event stream is connected (false while reconnecting). */
  connected: boolean
  /** Epoch ms of the last snapshot received. */
  updatedAt: number | null
  /** A problem the stream reported (for example a dead price feed). */
  streamNotice: string | null
  refresh(): Promise<void>
  /** Adopt the snapshot a write returned. */
  apply(snapshot: Snapshot): void
}

function useForeground(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

/**
 * The swing portfolio of one mode: the server's snapshot, kept current by the portfolio's event stream.
 * Opening it attaches the portfolio on the server once (as the website does); after that only the stream is read, no
 * polling. The stream is closed while the app is in the background and the portfolio is read again on return.
 * `enabled` is false until the screen may look (for real: after the phone's lock confirmed it is the owner).
 */
export function useSwingPortfolio({ mode, broker, enabled }: { mode: SwingMode; broker: Broker; enabled: boolean }): SwingPortfolioState {
  const { client } = useServices()
  const api = useMemo(() => createSwingApi(client), [client])
  const foreground = useForeground()
  const [status, setStatus] = useState<SwingStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [connected, setConnected] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [streamNotice, setStreamNotice] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const latest = useRef({ mode, broker })
  latest.current = { mode, broker }

  const adopt = useCallback((value: Snapshot) => { setSnapshot(value); setUpdatedAt(Date.now()); setStatus('ready'); setError(null) }, [])

  // Load: capabilities once, then the active portfolio of this mode.
  useEffect(() => {
    if (!enabled || !foreground) return
    const controller = new AbortController()
    setStatus(current => (current === 'ready' ? current : 'loading'))
    ;(async () => {
      try {
        const caps = await api.capabilities(controller.signal)
        setCapabilities(caps)
        if (mode === 'real' && !caps.real_trading_enabled) { setStatus('unavailable'); setError('Your account has no real-trading access.'); return }
        const value = await api.active(mode, broker, controller.signal)
        if (!controller.signal.aborted) adopt(value)
      } catch (caught) {
        if (isAbort(caught) || controller.signal.aborted) return
        if (isMissingEndpoint(caught)) { setStatus('unavailable'); setError('Swing trading is not available on this server.'); return }
        if (isForbidden(caught) && mode === 'real') { setStatus('unavailable'); setError('Your account has no real-trading access.'); return }
        setStatus('error'); setError(describeError(caught))
      }
    })()
    return () => controller.abort()
  }, [api, mode, broker, enabled, foreground, reload, adopt])

  // Follow: events of the portfolio that is shown.
  const portfolioId = snapshot?.portfolio?.session_id ?? null
  const portfolioMode = snapshot?.portfolio?.mode
  useEffect(() => {
    if (!enabled || !foreground || !portfolioId || portfolioMode !== mode) return
    const controller = new AbortController()
    setStreamNotice(null)
    void followPortfolio(client, portfolioId, event => {
      if (event.kind === 'snapshot') { adopt(event.snapshot); setStreamNotice(null) }
      else if (event.kind === 'refresh') setReload(value => value + 1)
      else setStreamNotice(event.message)
    }, controller.signal, setConnected)
    return () => { controller.abort(); setConnected(false) }
  }, [client, portfolioId, portfolioMode, mode, enabled, foreground, adopt])

  // A different mode starts from an empty screen, not the other mode's portfolio.
  useEffect(() => { setSnapshot(null); setUpdatedAt(null); setStatus('loading'); setError(null); setStreamNotice(null) }, [mode])

  const refresh = useCallback(async () => { setReload(value => value + 1) }, [])
  return { api, status, error, snapshot, capabilities, connected, updatedAt, streamNotice, refresh, apply: adopt }
}

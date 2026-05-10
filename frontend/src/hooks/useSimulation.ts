import { useState, useCallback } from 'react'
import api, { Trade, Position } from '../services/api'

export type SessionState = 'idle' | 'running' | 'paused' | 'ended'

export interface SimulationState {
  sessionId: string | null
  sessionState: SessionState
  currentPrice: number
  trades: Trade[]
  position: Position
  sseUrl: string | null
}

const DEFAULT_POSITION: Position = {
  symbol: 'NIFTY',
  quantity: 0,
  avg_entry_price: 0,
  side: 'FLAT',
}

export function useSimulation() {
  const [state, setState] = useState<SimulationState>({
    sessionId: null,
    sessionState: 'idle',
    currentPrice: 0,
    trades: [],
    position: DEFAULT_POSITION,
    sseUrl: null,
  })

  const updateCurrentPrice = useCallback((price: number) => {
    setState(s => ({ ...s, currentPrice: price }))
  }, [])

  const handleSessionEnded = useCallback(() => {
    setState(s => ({ ...s, sessionState: 'ended', sseUrl: null }))
  }, [])

  const startSession = useCallback(async (startTime: string, speed: number) => {
    const res = await api.startSimulation({ start_time: startTime, speed })
    setState(s => ({
      ...s,
      sessionId: res.session_id,
      sessionState: 'running',
      sseUrl: api.getSSEUrl(res.session_id),
      trades: [],
      position: DEFAULT_POSITION,
    }))
    return res.session_id
  }, [])

  const stopSession = useCallback(async () => {
    const id = state.sessionId
    // Reset to idle immediately so the UI is responsive; fire-and-forget the API call
    setState(s => ({
      ...s,
      sessionId: null,
      sessionState: 'idle',
      sseUrl: null,
      currentPrice: 0,
      trades: [],
      position: DEFAULT_POSITION,
    }))
    if (id) api.stopSimulation(id).catch(() => {/* session may already be gone */})
  }, [state.sessionId])

  const pauseSession = useCallback(async () => {
    if (!state.sessionId) return
    await api.pauseSimulation(state.sessionId)
    setState(s => ({ ...s, sessionState: 'paused' }))
  }, [state.sessionId])

  const resumeSession = useCallback(async () => {
    if (!state.sessionId) return
    await api.resumeSimulation(state.sessionId)
    setState(s => ({ ...s, sessionState: 'running' }))
  }, [state.sessionId])

  const buy = useCallback(async () => {
    if (!state.sessionId) return
    const trade = await api.buy(state.sessionId)
    setState(s => ({ ...s, trades: [...s.trades, trade] }))
    await refreshPosition()
  }, [state.sessionId])

  const sell = useCallback(async () => {
    if (!state.sessionId) return
    const trade = await api.sell(state.sessionId)
    setState(s => ({ ...s, trades: [...s.trades, trade] }))
    await refreshPosition()
  }, [state.sessionId])

  const refreshPosition = useCallback(async () => {
    if (!state.sessionId) return
    const pos = await api.getPosition(state.sessionId)
    setState(s => ({ ...s, position: pos }))
  }, [state.sessionId])

  const pnl = (() => {
    const { position, currentPrice } = state
    if (position.side === 'FLAT' || currentPrice === 0) return 0
    const direction = position.side === 'LONG' ? 1 : -1
    return direction * position.quantity * (currentPrice - position.avg_entry_price)
  })()

  return {
    ...state,
    pnl,
    startSession,
    stopSession,
    pauseSession,
    resumeSession,
    buy,
    sell,
    updateCurrentPrice,
    handleSessionEnded,
  }
}

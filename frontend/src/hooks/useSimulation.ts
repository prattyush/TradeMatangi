import { useState, useCallback } from 'react'
import api, { Trade, Position, Order, TickEvent, InsufficientFundsError } from '../services/api'

export type SessionState = 'idle' | 'running' | 'paused' | 'ended'

export interface SimulationState {
  sessionId: string | null
  sessionState: SessionState
  symbol: string
  date: string
  startTime: string | null
  currentPrice: number
  latestTick: TickEvent | null
  trades: Trade[]
  position: Position
  sseUrl: string | null
  openOrders: Order[]
  walletRefreshKey: number
  orderError: string | null
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
    symbol: 'NIFTY',
    date: '2026-05-06',
    startTime: null,
    currentPrice: 0,
    latestTick: null,
    trades: [],
    position: DEFAULT_POSITION,
    sseUrl: null,
    openOrders: [],
    walletRefreshKey: 0,
    orderError: null,
  })

  const updateCurrentPrice = useCallback((price: number) => {
    setState(s => ({ ...s, currentPrice: price }))
  }, [])

  const setLatestTick = useCallback((tick: TickEvent) => {
    setState(s => ({ ...s, latestTick: tick, currentPrice: tick.close }))
  }, [])

  const handleSessionEnded = useCallback(() => {
    setState(s => ({ ...s, sessionState: 'ended', sseUrl: null, latestTick: null }))
  }, [])

  // Update symbol/date in real-time as the user changes the dropdowns.
  // This pre-loads historical chart data so that when Start is clicked only
  // startTime changes — eliminating the race between the historical-data
  // refetch and the pre-session candle fetch.
  const updateSymbol = useCallback((symbol: string) => {
    setState(s => ({ ...s, symbol }))
  }, [])

  const updateDate = useCallback((date: string) => {
    setState(s => ({ ...s, date }))
  }, [])

  const startSession = useCallback(async (startTime: string, speed: number) => {
    const res = await api.startSimulation({
      symbol: state.symbol,
      date: state.date,
      start_time: startTime,
      speed,
    })
    setState(s => ({
      ...s,
      sessionId: res.session_id,
      sessionState: 'running',
      startTime: res.start_time,
      sseUrl: api.getSSEUrl(res.session_id),
      latestTick: null,
      trades: [],
      position: { ...DEFAULT_POSITION, symbol: res.symbol },
      openOrders: [],
      walletRefreshKey: s.walletRefreshKey + 1,
      orderError: null,
    }))
    return res.session_id
  }, [state.symbol, state.date])

  const stopSession = useCallback(async () => {
    const id = state.sessionId
    setState(s => ({
      ...s,
      sessionId: null,
      sessionState: 'idle',
      startTime: null,
      sseUrl: null,
      currentPrice: 0,
      latestTick: null,
      trades: [],
      position: DEFAULT_POSITION,
      openOrders: [],
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
    const pos = await api.getPosition(state.sessionId)
    setState(s => ({ ...s, position: pos }))
  }, [state.sessionId])

  const sell = useCallback(async () => {
    if (!state.sessionId) return
    const trade = await api.sell(state.sessionId)
    setState(s => ({ ...s, trades: [...s.trades, trade] }))
    const pos = await api.getPosition(state.sessionId)
    setState(s => ({ ...s, position: pos }))
  }, [state.sessionId])

  const clearOrderError = useCallback(() => {
    setState(s => ({ ...s, orderError: null }))
  }, [])

  const placeOrder = useCallback(async (
    side: 'BUY' | 'SELL',
    orderType: 'TARGET' | 'LIMIT' | 'STOPLOSS',
    price: number,
    quantity: number | null,
    opts: { is_stoploss?: boolean; funds_ratio_pct?: number } = {},
  ) => {
    if (!state.sessionId) return
    try {
      const order = await api.placeOrder(state.sessionId, side, orderType, price, quantity, opts)
      setState(s => ({
        ...s,
        openOrders: [...s.openOrders, order],
        walletRefreshKey: s.walletRefreshKey + 1,
        orderError: null,
      }))
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        setState(s => ({ ...s, orderError: err.message }))
      } else {
        throw err
      }
    }
  }, [state.sessionId])

  const cancelOrder = useCallback(async (orderId: string) => {
    if (!state.sessionId) return
    await api.cancelOrder(state.sessionId, orderId)
    setState(s => ({
      ...s,
      openOrders: s.openOrders.filter(o => o.order_id !== orderId),
      walletRefreshKey: s.walletRefreshKey + 1,
    }))
  }, [state.sessionId])

  const handleOrderFilled = useCallback(async (orderId: string) => {
    setState(s => ({
      ...s,
      openOrders: s.openOrders.filter(o => o.order_id !== orderId),
      walletRefreshKey: s.walletRefreshKey + 1,
    }))
    if (!state.sessionId) return
    const [pos, trades] = await Promise.all([
      api.getPosition(state.sessionId),
      api.getTrades(state.sessionId),
    ])
    setState(s => ({ ...s, position: pos, trades }))
  }, [state.sessionId])

  const pnl = (() => {
    const { position, currentPrice } = state
    if (position.side === 'FLAT' || currentPrice === 0) return 0
    const direction = position.side === 'LONG' ? 1 : -1
    return direction * position.quantity * (currentPrice - position.avg_entry_price)
  })()

  const incrementWalletRefreshKey = useCallback(() => {
    setState(s => ({ ...s, walletRefreshKey: s.walletRefreshKey + 1 }))
  }, [])

  return {
    ...state,
    pnl,
    updateSymbol,
    updateDate,
    startSession,
    stopSession,
    pauseSession,
    resumeSession,
    buy,
    sell,
    updateCurrentPrice,
    setLatestTick,
    handleSessionEnded,
    placeOrder,
    cancelOrder,
    handleOrderFilled,
    clearOrderError,
    incrementWalletRefreshKey,
  }
}

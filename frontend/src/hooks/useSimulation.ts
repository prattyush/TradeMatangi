import { useState, useCallback } from 'react'
import api, { Trade, Position, Order, TickEvent, InsufficientFundsError } from '../services/api'

export type SessionState = 'idle' | 'running' | 'paused' | 'ended'

const FLAT_POSITION = (symbol: string): Position => ({
  symbol, quantity: 0, avg_entry_price: 0, side: 'FLAT',
})

export interface SimulationState {
  sessionId: string | null
  sessionState: SessionState
  symbol: string
  date: string
  startTime: string | null
  // Equity price (or legacy single-right options price)
  currentPrice: number
  // Options dual-stream prices
  currentPriceCE: number
  currentPricePE: number
  // Per-type latest ticks for chart routing (single latestTick gets overwritten by batching)
  latestEquityTick: TickEvent | null
  latestCETick: TickEvent | null
  latestPETick: TickEvent | null
  trades: Trade[]
  position: Position           // equity position
  positionCE: Position         // options CE position
  positionPE: Position         // options PE position
  sseUrl: string | null
  openOrders: Order[]
  walletRefreshKey: number
  orderError: string | null
  // Session instrument info
  sessionInstrumentType: 'equity' | 'options'
  sessionCapital: number
  sessionStrike: number | null
  sessionStrikeCE: number | null   // CE streaming strike (may differ from PE when OTM offset != 0)
  sessionStrikePE: number | null   // PE streaming strike
  sessionExpiry: string | null
}

export interface InstrumentConfig {
  instrument_type: 'equity' | 'options'
  strike?: number
  expiry?: string
  strike_ce?: number
  strike_pe?: number
}

export function useSimulation() {
  const [state, setState] = useState<SimulationState>({
    sessionId: null,
    sessionState: 'idle',
    symbol: 'NIFTY',
    date: '2026-05-06',
    startTime: null,
    currentPrice: 0,
    currentPriceCE: 0,
    currentPricePE: 0,
    latestEquityTick: null,
    latestCETick: null,
    latestPETick: null,
    trades: [],
    position: FLAT_POSITION('NIFTY'),
    positionCE: FLAT_POSITION('NIFTY'),
    positionPE: FLAT_POSITION('NIFTY'),
    sseUrl: null,
    openOrders: [],
    walletRefreshKey: 0,
    orderError: null,
    sessionInstrumentType: 'equity',
    sessionCapital: 0,
    sessionStrike: null,
    sessionStrikeCE: null,
    sessionStrikePE: null,
    sessionExpiry: null,
  })

  const setLatestTick = useCallback((tick: TickEvent) => {
    setState(s => {
      const update: Partial<SimulationState> = {}
      if (!tick.right) {
        update.currentPrice = tick.close
        update.latestEquityTick = tick
      } else if (tick.right === 'CE') {
        update.currentPriceCE = tick.close
        update.latestCETick = tick
      } else if (tick.right === 'PE') {
        update.currentPricePE = tick.close
        update.latestPETick = tick
      }
      return { ...s, ...update }
    })
  }, [])

  const handleSessionEnded = useCallback(() => {
    setState(s => ({
      ...s, sessionState: 'ended', sseUrl: null,
      latestEquityTick: null, latestCETick: null, latestPETick: null,
    }))
  }, [])

  const updateSymbol = useCallback((symbol: string) => {
    setState(s => ({ ...s, symbol }))
  }, [])

  const updateDate = useCallback((date: string) => {
    setState(s => ({ ...s, date }))
  }, [])

  const startSession = useCallback(async (
    startTime: string,
    speed: number,
    instrumentConfig?: InstrumentConfig,
  ) => {
    const res = await api.startSimulation({
      symbol: state.symbol,
      date: state.date,
      start_time: startTime,
      speed,
      ...(instrumentConfig || { instrument_type: 'equity' }),
    })
    const sym = res.symbol
    setState(s => ({
      ...s,
      sessionId: res.session_id,
      sessionState: 'running',
      startTime: res.start_time,
      sseUrl: api.getSSEUrl(res.session_id),
      latestEquityTick: null,
      latestCETick: null,
      latestPETick: null,
      currentPrice: 0,
      currentPriceCE: 0,
      currentPricePE: 0,
      trades: [],
      position: FLAT_POSITION(sym),
      positionCE: FLAT_POSITION(sym),
      positionPE: FLAT_POSITION(sym),
      openOrders: [],
      walletRefreshKey: s.walletRefreshKey + 1,
      orderError: null,
      sessionInstrumentType: (res.instrument_type as 'equity' | 'options') || 'equity',
      sessionCapital: res.session_capital,
      sessionStrike: res.strike,
      sessionStrikeCE: res.strike_ce ?? res.strike,
      sessionStrikePE: res.strike_pe ?? res.strike,
      sessionExpiry: res.expiry,
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
      currentPriceCE: 0,
      currentPricePE: 0,
      latestEquityTick: null,
      latestCETick: null,
      latestPETick: null,
      trades: [],
      position: FLAT_POSITION(s.symbol),
      positionCE: FLAT_POSITION(s.symbol),
      positionPE: FLAT_POSITION(s.symbol),
      openOrders: [],
    }))
    if (id) api.stopSimulation(id).catch(() => {})
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

  const buy = useCallback(async (right?: string) => {
    if (!state.sessionId) return
    const trade = await api.buy(state.sessionId, right)
    setState(s => ({ ...s, trades: [...s.trades, trade] }))
    if (right === 'CE' || right === 'PE') {
      const pos = await api.getPosition(state.sessionId, right)
      setState(s => right === 'CE'
        ? { ...s, positionCE: pos, walletRefreshKey: s.walletRefreshKey + 1 }
        : { ...s, positionPE: pos, walletRefreshKey: s.walletRefreshKey + 1 }
      )
    } else {
      const pos = await api.getPosition(state.sessionId)
      setState(s => ({ ...s, position: pos, walletRefreshKey: s.walletRefreshKey + 1 }))
    }
  }, [state.sessionId])

  const sell = useCallback(async (right?: string) => {
    if (!state.sessionId) return
    const trade = await api.sell(state.sessionId, right)
    setState(s => ({ ...s, trades: [...s.trades, trade] }))
    if (right === 'CE' || right === 'PE') {
      const pos = await api.getPosition(state.sessionId, right)
      setState(s => right === 'CE'
        ? { ...s, positionCE: pos, walletRefreshKey: s.walletRefreshKey + 1 }
        : { ...s, positionPE: pos, walletRefreshKey: s.walletRefreshKey + 1 }
      )
    } else {
      const pos = await api.getPosition(state.sessionId)
      setState(s => ({ ...s, position: pos, walletRefreshKey: s.walletRefreshKey + 1 }))
    }
  }, [state.sessionId])

  const clearOrderError = useCallback(() => {
    setState(s => ({ ...s, orderError: null }))
  }, [])

  const updateOrder = useCallback(async (
    orderId: string,
    triggerPrice: number | undefined,
    limitPrice: number | undefined,
    targetDeviationPct?: number,
  ) => {
    if (!state.sessionId) return
    const updated = await api.updateOrder(state.sessionId, orderId, triggerPrice, limitPrice, targetDeviationPct)
    setState(s => ({
      ...s,
      openOrders: s.openOrders.map(o => o.order_id === orderId ? updated : o),
      walletRefreshKey: s.walletRefreshKey + 1,
    }))
  }, [state.sessionId])

  const placeOrder = useCallback(async (
    side: 'BUY' | 'SELL',
    orderType: 'TARGET' | 'LIMIT' | 'STOPLOSS',
    price: number,
    quantity: number | null,
    opts: { is_stoploss?: boolean; funds_ratio_pct?: number; right?: string; target_deviation_pct?: number } = {},
  ) => {
    if (!state.sessionId) return
    try {
      const order = await api.placeOrder(state.sessionId, side, orderType, price, quantity, {
        ...opts,
        ...(opts.target_deviation_pct != null ? { target_deviation_pct: opts.target_deviation_pct } : {}),
      })
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
    // Find the order to know its right
    const order = state.openOrders.find(o => o.order_id === orderId)
    setState(s => ({
      ...s,
      openOrders: s.openOrders.filter(o => o.order_id !== orderId),
      walletRefreshKey: s.walletRefreshKey + 1,
    }))
    if (!state.sessionId) return
    const right = order?.right
    const [posCE, posPE, posEq, trades] = await Promise.all([
      right === 'CE' ? api.getPosition(state.sessionId, 'CE') : Promise.resolve(null),
      right === 'PE' ? api.getPosition(state.sessionId, 'PE') : Promise.resolve(null),
      (!right) ? api.getPosition(state.sessionId) : Promise.resolve(null),
      api.getTrades(state.sessionId),
    ])
    setState(s => ({
      ...s,
      ...(posCE ? { positionCE: posCE } : {}),
      ...(posPE ? { positionPE: posPE } : {}),
      ...(posEq ? { position: posEq } : {}),
      trades,
    }))
  }, [state.sessionId, state.openOrders])

  // Day P&L: realized (closed trades) + unrealized (open position), equity
  const dayPnlEquity = (() => {
    let net = 0
    for (const t of state.trades) {
      if (t.right) continue  // skip options trades
      net += t.side === 'SELL' ? t.quantity * t.price : -t.quantity * t.price
    }
    const { position, currentPrice } = state
    if (position.side !== 'FLAT' && currentPrice > 0) {
      net += (position.side === 'LONG' ? 1 : -1) * position.quantity * currentPrice
    }
    return net
  })()

  // Day P&L: CE leg
  const dayPnlCE = (() => {
    let net = 0
    for (const t of state.trades) {
      if (t.right !== 'CE') continue
      net += t.side === 'SELL' ? t.quantity * t.price : -t.quantity * t.price
    }
    const { positionCE, currentPriceCE } = state
    if (positionCE.side !== 'FLAT' && currentPriceCE > 0) {
      net += (positionCE.side === 'LONG' ? 1 : -1) * positionCE.quantity * currentPriceCE
    }
    return net
  })()

  // Day P&L: PE leg
  const dayPnlPE = (() => {
    let net = 0
    for (const t of state.trades) {
      if (t.right !== 'PE') continue
      net += t.side === 'SELL' ? t.quantity * t.price : -t.quantity * t.price
    }
    const { positionPE, currentPricePE } = state
    if (positionPE.side !== 'FLAT' && currentPricePE > 0) {
      net += (positionPE.side === 'LONG' ? 1 : -1) * positionPE.quantity * currentPricePE
    }
    return net
  })()

  const dayPnl = state.sessionInstrumentType === 'options' ? dayPnlCE + dayPnlPE : dayPnlEquity

  // Unrealized P&L for equity sessions
  const pnlEquity = (() => {
    const { position, currentPrice } = state
    if (position.side === 'FLAT' || currentPrice === 0) return 0
    const direction = position.side === 'LONG' ? 1 : -1
    return direction * position.quantity * (currentPrice - position.avg_entry_price)
  })()

  // P&L for options sessions (CE + PE combined)
  const pnlOptions = (() => {
    const ce = (() => {
      const { positionCE, currentPriceCE } = state
      if (positionCE.side === 'FLAT' || currentPriceCE === 0) return 0
      const dir = positionCE.side === 'LONG' ? 1 : -1
      return dir * positionCE.quantity * (currentPriceCE - positionCE.avg_entry_price)
    })()
    const pe = (() => {
      const { positionPE, currentPricePE } = state
      if (positionPE.side === 'FLAT' || currentPricePE === 0) return 0
      const dir = positionPE.side === 'LONG' ? 1 : -1
      return dir * positionPE.quantity * (currentPricePE - positionPE.avg_entry_price)
    })()
    return ce + pe
  })()

  const pnl = state.sessionInstrumentType === 'options' ? pnlOptions : pnlEquity

  const incrementWalletRefreshKey = useCallback(() => {
    setState(s => ({ ...s, walletRefreshKey: s.walletRefreshKey + 1 }))
  }, [])

  return {
    ...state,
    pnl,
    pnlEquity,
    pnlOptions,
    dayPnl,
    dayPnlEquity,
    dayPnlCE,
    dayPnlPE,
    updateSymbol,
    updateDate,
    startSession,
    stopSession,
    pauseSession,
    resumeSession,
    buy,
    sell,
    setLatestTick,
    handleSessionEnded,
    placeOrder,
    updateOrder,
    cancelOrder,
    handleOrderFilled,
    clearOrderError,
    incrementWalletRefreshKey,
  }
}

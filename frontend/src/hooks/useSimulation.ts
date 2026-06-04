import { useState, useCallback, useRef } from 'react'
import api, { Trade, Position, Order, TickEvent, BarCandle, InsufficientFundsError } from '../services/api'

export type SessionState = 'idle' | 'running' | 'paused' | 'ended'

const FLAT_POSITION = (symbol: string): Position => ({
  symbol, quantity: 0, avg_entry_price: 0, side: 'FLAT', entry_commission: 0,
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
  historicalTrades: Trade[]    // trades from previous sessions (same symbol+date+type)
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
  sessionType: string              // 'sim' | 'paper' | 'real' | 'stepwise'
  brokeragePerOrder: number        // flat brokerage per trade (from user settings)
  // Stepwise replayer state
  stepwise: boolean
  barPaused: boolean               // true when waiting for user to press Next Bar
  barIndex: number                 // current bar index (1-based)
  totalBars: number                // total bars in the day
  lastCompletedBarEquity: BarCandle | null
  lastCompletedBarCE: BarCandle | null
  lastCompletedBarPE: BarCandle | null
}

export interface InstrumentConfig {
  instrument_type: 'equity' | 'options'
  strike?: number
  expiry?: string
  strike_ce?: number
  strike_pe?: number
  brokerage_per_order?: number
  strategy_interval_secs?: number
  session_type?: 'sim' | 'paper' | 'real' | 'stepwise'
}

export function useSimulation() {
  // Ref keeps the latest equity tick accessible synchronously inside buy/sell/addTradeFromSSE
  // callbacks without adding latestEquityTick to their dependency arrays.
  const latestEquityTickRef = useRef<TickEvent | null>(null)

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
    historicalTrades: [],
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
    sessionType: 'sim',
    brokeragePerOrder: 0,
    stepwise: false,
    barPaused: false,
    barIndex: 0,
    totalBars: 0,
    lastCompletedBarEquity: null,
    lastCompletedBarCE: null,
    lastCompletedBarPE: null,
  })

  const setLatestTick = useCallback((tick: TickEvent) => {
    setState(s => {
      const update: Partial<SimulationState> = {}
      if (!tick.right) {
        update.currentPrice = tick.close
        update.latestEquityTick = tick
        latestEquityTickRef.current = tick
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

  const updateSessionStrike = useCallback((right: 'CE' | 'PE', strike: number) => {
    setState(s => ({
      ...s,
      sessionStrikeCE: right === 'CE' ? strike : s.sessionStrikeCE,
      sessionStrikePE: right === 'PE' ? strike : s.sessionStrikePE,
    }))
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
    const instrumentType = (res.instrument_type as 'equity' | 'options') || 'equity'
    const sessionType = instrumentConfig?.session_type ?? 'sim'
    const isStepwise = res.stepwise === true
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
      historicalTrades: [],
      position: FLAT_POSITION(sym),
      positionCE: FLAT_POSITION(sym),
      positionPE: FLAT_POSITION(sym),
      openOrders: [],
      walletRefreshKey: s.walletRefreshKey + 1,
      orderError: null,
      sessionInstrumentType: instrumentType,
      sessionCapital: res.session_capital,
      sessionStrike: res.strike,
      sessionStrikeCE: res.strike_ce ?? res.strike,
      sessionStrikePE: res.strike_pe ?? res.strike,
      sessionExpiry: res.expiry,
      sessionType,
      brokeragePerOrder: instrumentConfig?.brokerage_per_order ?? 0,
      stepwise: isStepwise,
      barPaused: false,
      barIndex: 0,
      totalBars: res.total_bars ?? 0,
      lastCompletedBarEquity: null,
      lastCompletedBarCE: null,
      lastCompletedBarPE: null,
    }))
    // Fire-and-forget: load previous-session trades for same user+symbol+date+type
    const currentSessionId = res.session_id
    api.getTradesByContext(sym, state.date, instrumentType, sessionType).then(({ trades }) => {
      setState(s => ({ ...s, historicalTrades: trades.filter(t => t.session_id !== currentSessionId) }))
    }).catch(() => {})
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
      historicalTrades: [],
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
    const resp = await api.buy(state.sessionId, right)
    // For real sessions, backend returns {status:"broker_pending"} — trade arrives via SSE order_filled
    if ('status' in resp && resp.status === 'broker_pending') return
    const trade = resp as import('../services/api').Trade
    if (trade.right && latestEquityTickRef.current) {
      trade.underlying_price = latestEquityTickRef.current.close
    }
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
    const resp = await api.sell(state.sessionId, right)
    // For real sessions, backend returns {status:"broker_pending"} — trade arrives via SSE order_filled
    if ('status' in resp && resp.status === 'broker_pending') return
    const trade = resp as import('../services/api').Trade
    if (trade.right && latestEquityTickRef.current) {
      trade.underlying_price = latestEquityTickRef.current.close
    }
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
        openOrders: s.openOrders.some(o => o.order_id === order.order_id)
          ? s.openOrders
          : [...s.openOrders, order],
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

  const addOpenOrder = useCallback((order: Order) => {
    setState(s => {
      if (s.openOrders.some(o => o.order_id === order.order_id)) return s
      return { ...s, openOrders: [...s.openOrders, order] }
    })
  }, [])

  const cancelOrder = useCallback(async (orderId: string) => {
    if (!state.sessionId) return
    await api.cancelOrder(state.sessionId, orderId)
    setState(s => ({
      ...s,
      openOrders: s.openOrders.filter(o => o.order_id !== orderId),
      walletRefreshKey: s.walletRefreshKey + 1,
    }))
  }, [state.sessionId])

  const handleOrderCancelled = useCallback((orderId: string) => {
    setState(s => ({
      ...s,
      openOrders: s.openOrders.filter(o => o.order_id !== orderId),
      walletRefreshKey: s.walletRefreshKey + 1,
    }))
  }, [])

  const handleOrderFilled = useCallback(async (orderId: string, right: string | null | undefined) => {
    setState(s => ({
      ...s,
      openOrders: s.openOrders.filter(o => o.order_id !== orderId),
      walletRefreshKey: s.walletRefreshKey + 1,
    }))
    if (!state.sessionId) return
    // Use right from the event payload — order may not be in openOrders if placed by a strategy
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
  }, [state.sessionId])

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

  // Mirrors backend compute_commission — used to estimate exit cost at current price
  const estimateExitCommission = (side: 'BUY' | 'SELL', price: number, qty: number): number => {
    if (price === 0 || qty === 0) return 0
    const val = price * qty
    const charges = side === 'BUY'
      ? val * 0.006803 / 100
      : val * 0.0625 / 100 + 1.18 * (0.06 / 100) * val
    return charges + state.brokeragePerOrder
  }

  // Unrealized P&L net of entry commission + estimated exit commission at current price
  const pnlEquity = (() => {
    const { position, currentPrice } = state
    if (position.side === 'FLAT' || currentPrice === 0) return 0
    const direction = position.side === 'LONG' ? 1 : -1
    const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY'
    return direction * position.quantity * (currentPrice - position.avg_entry_price)
      - position.entry_commission
      - estimateExitCommission(exitSide, currentPrice, position.quantity)
  })()

  // P&L for options sessions (CE + PE combined, each net of both commissions)
  const pnlOptions = (() => {
    const ce = (() => {
      const { positionCE, currentPriceCE } = state
      if (positionCE.side === 'FLAT' || currentPriceCE === 0) return 0
      const dir = positionCE.side === 'LONG' ? 1 : -1
      const exitSide = positionCE.side === 'LONG' ? 'SELL' : 'BUY'
      return dir * positionCE.quantity * (currentPriceCE - positionCE.avg_entry_price)
        - positionCE.entry_commission
        - estimateExitCommission(exitSide, currentPriceCE, positionCE.quantity)
    })()
    const pe = (() => {
      const { positionPE, currentPricePE } = state
      if (positionPE.side === 'FLAT' || currentPricePE === 0) return 0
      const dir = positionPE.side === 'LONG' ? 1 : -1
      const exitSide = positionPE.side === 'LONG' ? 'SELL' : 'BUY'
      return dir * positionPE.quantity * (currentPricePE - positionPE.avg_entry_price)
        - positionPE.entry_commission
        - estimateExitCommission(exitSide, currentPricePE, positionPE.quantity)
    })()
    return ce + pe
  })()

  const pnl = state.sessionInstrumentType === 'options' ? pnlOptions : pnlEquity

  // Realized P&L from previous sessions (net of commissions) — contributes to Day P&L header
  const prevDayPnl = (() => {
    let net = 0
    for (const t of state.historicalTrades) {
      net += t.side === 'SELL' ? t.quantity * t.price : -t.quantity * t.price
      net -= (t.commission ?? 0)
    }
    return net
  })()

  const incrementWalletRefreshKey = useCallback(() => {
    setState(s => ({ ...s, walletRefreshKey: s.walletRefreshKey + 1 }))
  }, [])

  const handleBarPaused = useCallback((
    barIndex: number,
    totalBars: number,
    equity: BarCandle | null,
    ce: BarCandle | null,
    pe: BarCandle | null,
  ) => {
    setState(s => ({
      ...s,
      barPaused: true,
      barIndex,
      totalBars,
      lastCompletedBarEquity: equity ?? s.lastCompletedBarEquity,
      lastCompletedBarCE: ce ?? s.lastCompletedBarCE,
      lastCompletedBarPE: pe ?? s.lastCompletedBarPE,
    }))
  }, [])

  const nextBar = useCallback(async () => {
    if (!state.sessionId || !state.stepwise) return
    setState(s => ({ ...s, barPaused: false }))
    await api.nextBar(state.sessionId)
  }, [state.sessionId, state.stepwise])

  const setTrades = useCallback((trades: Trade[]) => {
    setState(s => ({ ...s, trades }))
  }, [])

  const fetchAndUpdatePosition = useCallback(async () => {
    if (!state.sessionId) return
    const [posEq, posCE, posPE] = await Promise.all([
      api.getPosition(state.sessionId),
      api.getPosition(state.sessionId, 'CE'),
      api.getPosition(state.sessionId, 'PE'),
    ])
    setState(s => ({
      ...s,
      position: posEq,
      positionCE: posCE,
      positionPE: posPE,
      walletRefreshKey: s.walletRefreshKey + 1,
    }))
  }, [state.sessionId])

  const addTradeFromSSE = useCallback(async (trade: Trade) => {
    // Stamp underlying price for CE/PE trades that arrive via SSE (AI-placed orders)
    if (trade.right && latestEquityTickRef.current && trade.underlying_price === undefined) {
      trade.underlying_price = latestEquityTickRef.current.close
    }
    // Deduplicate: UI-initiated trades are already in state from api.buy/sell response
    setState(s => {
      if (s.trades.some(t => t.trade_id === trade.trade_id)) return s
      return { ...s, trades: [...s.trades, trade] }
    })
    // Refresh position so P&L reflects the AI-placed order
    if (!state.sessionId) return
    const right = trade.right as string | undefined
    const [posCE, posPE, posEq] = await Promise.all([
      right === 'CE' ? api.getPosition(state.sessionId, 'CE') : Promise.resolve(null),
      right === 'PE' ? api.getPosition(state.sessionId, 'PE') : Promise.resolve(null),
      (!right) ? api.getPosition(state.sessionId) : Promise.resolve(null),
    ])
    setState(s => ({
      ...s,
      walletRefreshKey: s.walletRefreshKey + 1,
      ...(posCE ? { positionCE: posCE } : {}),
      ...(posPE ? { positionPE: posPE } : {}),
      ...(posEq ? { position: posEq } : {}),
    }))
  }, [state.sessionId])

  return {
    ...state,
    pnl,
    pnlEquity,
    pnlOptions,
    dayPnl,
    dayPnlEquity,
    dayPnlCE,
    dayPnlPE,
    prevDayPnl,
    updateSymbol,
    updateDate,
    updateSessionStrike,
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
    handleOrderCancelled,
    addOpenOrder,
    clearOrderError,
    incrementWalletRefreshKey,
    setTrades,
    addTradeFromSSE,
    fetchAndUpdatePosition,
    handleBarPaused,
    nextBar,
  }
}

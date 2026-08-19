import { useState, useCallback, useRef } from 'react'
import api, { Trade, Position, Order, TickEvent, BarCandle, InsufficientFundsError } from '../services/api'

export type SessionState = 'idle' | 'running' | 'paused' | 'ended'

export interface PendingExitRt {
  right: string | null          // null = equity, 'CE' | 'PE' for options
  round_trip_index: number
  pnl: number
  closed_at: number             // unix ms timestamp when the leg went flat
}

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
  // In-session trade labeling
  pendingExitLabels: PendingExitRt[]
  savedEntryRtKeys: string[]       // dedupe: "sessionId#rtIdx#right" for entries already saved
  savedExitRtKeys: string[]        // dedupe: same for exits already saved
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
    pendingExitLabels: [],
    savedEntryRtKeys: [],
    savedExitRtKeys: [],
  })

  const setLatestTick = useCallback((tick: TickEvent) => {
    // Update ref synchronously so any concurrent buy/sell/handleOrderFilled reads the latest price
    if (!tick.right) latestEquityTickRef.current = tick
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
    // Reload this session's own trades from backend (populated from DB on resume)
    api.getTrades(currentSessionId).then(trades => {
      if (trades.length > 0) setState(s => ({ ...s, trades }))
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

  const computeNetQty = useCallback((trades: Trade[]) => {
    let eq = 0, ce = 0, pe = 0
    for (const t of trades) {
      const sign = t.side === 'BUY' ? 1 : -1
      if (!t.right) eq += sign * t.quantity
      else if (t.right === 'CE') ce += sign * t.quantity
      else if (t.right === 'PE') pe += sign * t.quantity
    }
    return { eq, ce, pe }
  }, [])

  // Add a trade and detect RT open/close in a single setState — no separate
  // effect needed. This avoids the race where a subsequent position-update
  // setState overwrites the pendingExitLabels update.
  const addTradeAndDetectLabels = useCallback((trade: Trade) => {
    setState(s => {
      if (!s.sessionId) return { ...s, trades: [...s.trades, trade] }
      const updatedTrades = [...s.trades, trade]
      const { eq, ce, pe } = computeNetQty(updatedTrades)
      const prev = lastNetQtyRef.current
      console.log(`[LabelWatcher] addTradeAndDetect: trades=${updatedTrades.length} prev_eq=${prev.eq} cur_eq=${eq} ce=${prev.ce}->${ce} pe=${prev.pe}->${pe} counter=${rtIndexCounterRef.current}`)

      let newPending = s.pendingExitLabels

      const check = (
        right: string | null,
        prevQty: number,
        curQty: number,
      ) => {
        if (curQty !== 0 && prevQty === 0) {
          rtIndexCounterRef.current++
          return
        }
        if (prevQty !== 0 && curQty === 0) {
          const rtIdx = rtIndexCounterRef.current
          const legTrades = updatedTrades.filter(t => (right === null ? !t.right : t.right === right))
          let pnl = 0
          for (const t of legTrades) {
            if (t.side === 'SELL') pnl += t.price * t.quantity
            else pnl -= t.price * t.quantity
          }
          const key = `${s.sessionId}#${rtIdx}#${right ?? 'EQ'}`
          if (!(s.savedExitRtKeys ?? []).includes(key)) {
            console.log(`[LabelWatcher] CLOSE right=${right} rtIdx=${rtIdx} pnl=${pnl} key=${key}`)
            newPending = [...newPending, {
              right,
              round_trip_index: rtIdx,
              pnl: Math.round(pnl * 100) / 100,
              closed_at: Date.now(),
            }]
          }
        }
      }

      check(null, prev.eq, eq)
      check('CE', prev.ce, ce)
      check('PE', prev.pe, pe)

      lastNetQtyRef.current = { eq, ce, pe }

      return { ...s, trades: updatedTrades, pendingExitLabels: newPending }
    })
  }, [computeNetQty])

  const buy = useCallback(async (right?: string) => {
    if (!state.sessionId) return
    const resp = await api.buy(state.sessionId, right)
    if ('status' in resp && resp.status === 'broker_pending') return
    const trade = resp as import('../services/api').Trade
    if (trade.right && latestEquityTickRef.current) {
      trade.underlying_price = latestEquityTickRef.current.close
    }
    addTradeAndDetectLabels(trade)
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
  }, [state.sessionId, addTradeAndDetectLabels])

  const sell = useCallback(async (right?: string) => {
    if (!state.sessionId) return
    const resp = await api.sell(state.sessionId, right)
    if ('status' in resp && resp.status === 'broker_pending') return
    const trade = resp as import('../services/api').Trade
    if (trade.right && latestEquityTickRef.current) {
      trade.underlying_price = latestEquityTickRef.current.close
    }
    addTradeAndDetectLabels(trade)
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
  }, [state.sessionId, addTradeAndDetectLabels])

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

  const handleOrderConverted = useCallback((
    orderId: string,
    newOrderType: string,
    triggerPrice: number,
    limitPrice: number,
    isStoploss: boolean,
  ) => {
    setState(s => ({
      ...s,
      openOrders: s.openOrders.map(o =>
        o.order_id === orderId
          ? { ...o, order_type: newOrderType as Order['order_type'], trigger_price: triggerPrice, limit_price: limitPrice, is_stoploss: isStoploss }
          : o
      ),
    }))
  }, [])

  const handleOrderFilled = useCallback(async (orderId: string, right: string | null | undefined) => {
    setState(s => ({
      ...s,
      openOrders: s.openOrders.filter(o => o.order_id !== orderId),
      walletRefreshKey: s.walletRefreshKey + 1,
    }))
    if (!state.sessionId) return
    // Capture equity price synchronously before the async fetch so we can stamp
    // underlying_price on newly-filled CE/PE trades (backend never sets this field)
    const equityTickAtFill = latestEquityTickRef.current
    // Use right from the event payload — order may not be in openOrders if placed by a strategy
    const [posCE, posPE, posEq, trades] = await Promise.all([
      right === 'CE' ? api.getPosition(state.sessionId, 'CE') : Promise.resolve(null),
      right === 'PE' ? api.getPosition(state.sessionId, 'PE') : Promise.resolve(null),
      (!right) ? api.getPosition(state.sessionId) : Promise.resolve(null),
      api.getTrades(state.sessionId),
    ])
    setState(s => {
      const prevById = new Map(s.trades.map(t => [t.trade_id, t]))
      const stamped = trades.map(t => {
        const prev = prevById.get(t.trade_id)
        if (prev?.underlying_price !== undefined) return { ...t, underlying_price: prev.underlying_price }
        if (t.right && equityTickAtFill) return { ...t, underlying_price: equityTickAtFill.close }
        return t
      })
      const { eq, ce, pe } = computeNetQty(stamped)
      const prev = lastNetQtyRef.current
      let newPending = s.pendingExitLabels
      const check = (rtRight: string | null, prevQty: number, curQty: number) => {
        if (curQty !== 0 && prevQty === 0) { rtIndexCounterRef.current++; return }
        if (prevQty !== 0 && curQty === 0) {
          const rtIdx = rtIndexCounterRef.current
          const legTrades = stamped.filter(t => (rtRight === null ? !t.right : t.right === rtRight))
          let pnl = 0
          for (const t of legTrades) { if (t.side === 'SELL') pnl += t.price * t.quantity; else pnl -= t.price * t.quantity }
          const key = `${s.sessionId}#${rtIdx}#${rtRight ?? 'EQ'}`
          if (!(s.savedExitRtKeys ?? []).includes(key)) {
            newPending = [...newPending, { right: rtRight, round_trip_index: rtIdx, pnl: Math.round(pnl * 100) / 100, closed_at: Date.now() }]
          }
        }
      }
      check(null, prev.eq, eq); check('CE', prev.ce, ce); check('PE', prev.pe, pe)
      lastNetQtyRef.current = { eq, ce, pe }
      return {
        ...s,
        ...(posCE ? { positionCE: posCE } : {}),
        ...(posPE ? { positionPE: posPE } : {}),
        ...(posEq ? { position: posEq } : {}),
        trades: stamped,
        pendingExitLabels: newPending,
      }
    })
  }, [state.sessionId, computeNetQty])

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

  // Unrealized P&L for CE leg
  const pnlCE = (() => {
    const { positionCE, currentPriceCE } = state
    if (positionCE.side === 'FLAT' || currentPriceCE === 0) return 0
    const dir = positionCE.side === 'LONG' ? 1 : -1
    const exitSide = positionCE.side === 'LONG' ? 'SELL' : 'BUY'
    return dir * positionCE.quantity * (currentPriceCE - positionCE.avg_entry_price)
      - positionCE.entry_commission
      - estimateExitCommission(exitSide, currentPriceCE, positionCE.quantity)
  })()

  // Unrealized P&L for PE leg
  const pnlPE = (() => {
    const { positionPE, currentPricePE } = state
    if (positionPE.side === 'FLAT' || currentPricePE === 0) return 0
    const dir = positionPE.side === 'LONG' ? 1 : -1
    const exitSide = positionPE.side === 'LONG' ? 'SELL' : 'BUY'
    return dir * positionPE.quantity * (currentPricePE - positionPE.avg_entry_price)
      - positionPE.entry_commission
      - estimateExitCommission(exitSide, currentPricePE, positionPE.quantity)
  })()

  const pnlOptions = pnlCE + pnlPE

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
    const equityTick = latestEquityTickRef.current
    setState(s => {
      const prevById = new Map(s.trades.map(t => [t.trade_id, t]))
      const stamped = trades.map(t => {
        const prev = prevById.get(t.trade_id)
        if (prev?.underlying_price !== undefined) return { ...t, underlying_price: prev.underlying_price }
        if (t.right && equityTick) return { ...t, underlying_price: equityTick.close }
        return t
      })
      return { ...s, trades: stamped }
    })
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
    if (trade.right && latestEquityTickRef.current && trade.underlying_price === undefined) {
      trade.underlying_price = latestEquityTickRef.current.close
    }
    // Deduplicate: UI-initiated trades are already in state from api.buy/sell response.
    // Use addTradeAndDetectLabels which handles both adding the trade AND running
    // RT open/close detection in the same setState (avoids race with position update).
    setState(s => {
      if (s.trades.some(t => t.trade_id === trade.trade_id)) return s
      // Delegate to addTradeAndDetectLabels logic inline to keep it atomic
      const updatedTrades = [...s.trades, trade]
      if (!s.sessionId) return { ...s, trades: updatedTrades }
      const { eq, ce, pe } = computeNetQty(updatedTrades)
      const prev = lastNetQtyRef.current
      let newPending = s.pendingExitLabels
      const check = (right: string | null, prevQty: number, curQty: number) => {
        if (curQty !== 0 && prevQty === 0) { rtIndexCounterRef.current++; return }
        if (prevQty !== 0 && curQty === 0) {
          const rtIdx = rtIndexCounterRef.current
          const legTrades = updatedTrades.filter(t => (right === null ? !t.right : t.right === right))
          let pnl = 0
          for (const t of legTrades) { if (t.side === 'SELL') pnl += t.price * t.quantity; else pnl -= t.price * t.quantity }
          const key = `${s.sessionId}#${rtIdx}#${right ?? 'EQ'}`
          if (!(s.savedExitRtKeys ?? []).includes(key)) {
            newPending = [...newPending, { right, round_trip_index: rtIdx, pnl: Math.round(pnl * 100) / 100, closed_at: Date.now() }]
          }
        }
      }
      check(null, prev.eq, eq); check('CE', prev.ce, ce); check('PE', prev.pe, pe)
      lastNetQtyRef.current = { eq, ce, pe }
      return { ...s, trades: updatedTrades, pendingExitLabels: newPending }
    })
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
  }, [state.sessionId, computeNetQty])

  const bulkUpdateOrders = useCallback((updatedOrders: Order[]) => {
    if (updatedOrders.length === 0) return
    const updatedMap = new Map(updatedOrders.map(o => [o.order_id, o]))
    setState(s => ({
      ...s,
      openOrders: s.openOrders.map(o => updatedMap.get(o.order_id) || o),
      walletRefreshKey: s.walletRefreshKey + 1,
    }))
  }, [])

  // ── In-session trade labeling ───────────────────────────────────────────────
  // Per-leg net-qty snapshot — detect non-zero → 0 transitions to identify
  // completed round-trips. Works for ALL session types (sim/paper/real/stepwise).
  // Refs instead of state so the watcher can read them synchronously without
  // being in the dependency array of the effect that writes them.
  const lastNetQtyRef = useRef<{ eq: number; ce: number; pe: number }>({ eq: 0, ce: 0, pe: 0 })
  const rtIndexCounterRef = useRef(0)  // single global counter, matches backend _fifo_match_trades

  // Reset label state when a new session starts or ends
  const resetLabelTracking = useCallback(() => {
    lastNetQtyRef.current = { eq: 0, ce: 0, pe: 0 }
    rtIndexCounterRef.current = 0
    setState(s => ({
      ...s,
      pendingExitLabels: [],
      savedEntryRtKeys: [],
      savedExitRtKeys: [],
    }))
  }, [])

  const getOpenRtIndex = useCallback((_right: string | null): number => {
    return rtIndexCounterRef.current
  }, [])

  const recordSavedEntry = useCallback((sessionId: string, rtIndex: number, right: string | null) => {
    const key = `${sessionId}#${rtIndex}#${right ?? 'EQ'}`
    setState(s => {
      if (s.savedEntryRtKeys.includes(key)) return s
      return { ...s, savedEntryRtKeys: [...s.savedEntryRtKeys, key] }
    })
  }, [])

  const recordSavedExit = useCallback((sessionId: string, rtIndex: number, right: string | null) => {
    const key = `${sessionId}#${rtIndex}#${right ?? 'EQ'}`
    setState(s => {
      const filteredPending = s.pendingExitLabels.filter(
        p => !(p.round_trip_index === rtIndex && (p.right ?? 'EQ') === (right ?? 'EQ')),
      )
      const nextExitKeys = s.savedExitRtKeys.includes(key)
        ? s.savedExitRtKeys
        : [...s.savedExitRtKeys, key]
      return { ...s, pendingExitLabels: filteredPending, savedExitRtKeys: nextExitKeys }
    })
  }, [])

  return {
    ...state,
    pnl,
    pnlEquity,
    pnlCE,
    pnlPE,
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
    bulkUpdateOrders,
    cancelOrder,
    handleOrderFilled,
    handleOrderCancelled,
    handleOrderConverted,
    addOpenOrder,
    clearOrderError,
    incrementWalletRefreshKey,
    setTrades,
    addTradeFromSSE,
    fetchAndUpdatePosition,
    handleBarPaused,
    nextBar,
    resetLabelTracking,
    getOpenRtIndex,
    recordSavedEntry,
    recordSavedExit,
  }
}

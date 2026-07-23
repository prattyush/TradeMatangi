import { useCallback, useEffect, useRef, useState } from 'react'
import React from 'react'
import PatternLibrary from './pages/PatternLibrary'
import ChartStructures from './pages/ChartStructures'
import Chart, { PaneType } from './components/Chart'
import SessionControls, { OptionsReadyConfig } from './components/SessionControls'
import TradePanel from './components/TradePanel'
import TradeHistory from './components/TradeHistory'
import OrderPanel from './components/OrderPanel'
import WalletWidget from './components/WalletWidget'
import GuardRailPopup from './components/GuardRailPopup'
import PatternAlertToast, { PatternAlert } from './components/PatternAlertToast'
import SettingsModal, { loadFundsRatioMode, loadFundsRatios, loadTargetDeviationPct, loadBrokeragePerOrder, loadStrategyIntervalSecs, loadAutostopTriggerType, loadAutostopDeviationPct, loadHistoricalDays, loadPnlPctMode, loadBreakevenMode, loadTargetProfitBufferTicks, loadAggrSlOnlyInProfit, loadAutoStartEventSnapshots, loadStepwiseLabelingPopupEnabled, FundsRatios } from './components/SettingsModal'
import { StrategyResponse, StartStrategyRequest, Order } from './services/api'
import LoginScreen from './components/LoginScreen'
import TradeAnalysis from './components/TradeAnalysis'
import StepwiseLabelPopup from './components/StepwiseLabelPopup'
import AIChatPanel from './components/AIChatPanel'
import { useSimulation, InstrumentConfig } from './hooks/useSimulation'
import { useSSE } from './hooks/useSSE'
import { useRecording } from './hooks/useRecording'
import { useSnapshot } from './hooks/useSnapshot'
import api from './services/api'

const FIXED_USER = { userId: 'abc12300-0000-0000-0000-000000000001', username: 'abc123' }

function loadAuthUser(): { userId: string; email: string; isAdmin: boolean; accountName?: string } | null {
  try {
    const raw = localStorage.getItem('auth_user')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return { isAdmin: false, ...parsed }
  } catch {
    return null
  }
}

// ── Pane config ──────────────────────────────────────────────────────────────
interface PaneConfig {
  id: number
  type: PaneType
  intervalMinutes: number
  // Options fields (only for type='options')
  strike?: number
  expiry?: string
  right?: 'CE' | 'PE'
  liveFromTs?: number
  reloadKey?: number
}

type LayoutPreset = 1 | 2 | 3 | 4
const INTERVAL_OPTIONS = [1, 3, 5, 15, 30]
let nextPaneId = 10

function makeEquityPane(intervalMinutes: number): PaneConfig {
  return { id: nextPaneId++, type: 'equity', intervalMinutes }
}

function makeOptionsPane(right: 'CE' | 'PE', strike: number, expiry: string): PaneConfig {
  return { id: nextPaneId++, type: 'options', intervalMinutes: 3, right, strike, expiry }
}

// Default pane sets
const DEFAULT_EQUITY_PANES: PaneConfig[] = [
  { id: 1, type: 'equity', intervalMinutes: 3 },
  { id: 2, type: 'equity', intervalMinutes: 5 },
]

// ── Layout helpers ───────────────────────────────────────────────────────────
function defaultPanesForLayout(preset: LayoutPreset, current: PaneConfig[]): PaneConfig[] {
  const n = preset  // target pane count
  if (current.length >= n) return current.slice(0, n)
  const extras: PaneConfig[] = []
  const intervals = [15, 30, 1, 5]
  while (current.length + extras.length < n) {
    extras.push(makeEquityPane(intervals[extras.length] ?? 3))
  }
  return [...current, ...extras]
}

export default function App() {
  // ── Auth state ──────────────────────────────────────────────────────────────
  const [authUser, setAuthUser] = useState(loadAuthUser)

  const handleLogin = useCallback((userId: string, email: string, isAdmin = false, accountName?: string) => {
    const user = { userId, email, isAdmin, accountName }
    localStorage.setItem('auth_user', JSON.stringify(user))
    localStorage.setItem('user', JSON.stringify({ userId, username: email }))
    setAuthUser(user)
  }, [])

  const handleLogout = useCallback(() => {
    localStorage.removeItem('auth_user')
    setAuthUser(null)
  }, [])

  // Refresh isAdmin and account_name from server on mount (handles stale localStorage on role change)
  useEffect(() => {
    if (!authUser) return
    api.getMe().then(me => {
      setAuthUser(prev => prev ? { ...prev, isAdmin: me.is_admin, accountName: me.account_name ?? undefined } : prev)
      const stored = localStorage.getItem('auth_user')
      if (stored) {
        try {
          const parsed = JSON.parse(stored)
          localStorage.setItem('auth_user', JSON.stringify({ ...parsed, isAdmin: me.is_admin, accountName: me.account_name }))
        } catch { /* ignore */ }
      }
    }).catch(() => {})
  }, [])  // mount only

  if (!authUser) {
    return <LoginScreen onLogin={handleLogin} />
  }

  return <AppInner authUser={authUser} onLogout={handleLogout} setAuthUser={setAuthUser} />
}

function AppInner({ authUser, onLogout, setAuthUser }: { authUser: { userId: string; email: string; isAdmin: boolean; accountName?: string }; onLogout: () => void; setAuthUser: React.Dispatch<React.SetStateAction<{ userId: string; email: string; isAdmin: boolean; accountName?: string } | null>> }) {
  const sim = useSimulation()
  const { recordingState, recordingError, startRecording, pauseRecording, resumeRecording, stopRecording } = useRecording()
  const simRef = useRef(sim)
  // Keep simRef in sync with latest sim state for useSnapshot
  useEffect(() => { simRef.current = sim }, [sim])
  const { snapshotActive, startSnapshots, stopSnapshots, captureSnapshot } = useSnapshot(simRef)
  const [recDropdownOpen, setRecDropdownOpen] = useState(false)
  const [fundsRatioMode, setFundsRatioMode] = useState(loadFundsRatioMode)
  const [fundsRatios, setFundsRatios] = useState<FundsRatios>(loadFundsRatios)
  const [targetDeviationPct, setTargetDeviationPct] = useState(loadTargetDeviationPct)
  const [brokeragePerOrder, setBrokeragePerOrder] = useState(loadBrokeragePerOrder)
  const [stratIntervalSecs, setStratIntervalSecs] = useState(loadStrategyIntervalSecs)
  const [autostopTriggerType, setAutostopTriggerType] = useState(loadAutostopTriggerType)
  const [autostopDeviationPct, setAutostopDeviationPct] = useState(loadAutostopDeviationPct)
  const [breakevenMode, setBreakevenMode] = useState(loadBreakevenMode)
  const [targetProfitBufferTicks, setTargetProfitBufferTicks] = useState(loadTargetProfitBufferTicks)
  const [aggrSlOnlyInProfit, setAggrSlOnlyInProfit] = useState(loadAggrSlOnlyInProfit)
  const [historicalDays, setHistoricalDays] = useState(loadHistoricalDays)
  const [pnlPctMode, setPnlPctMode] = useState(loadPnlPctMode)
  const [runningStrategies, setRunningStrategies] = useState<StrategyResponse[]>([])
  const [brokerError, setBrokerError] = useState<string | null>(null)
  const [isRealTradingUser, setIsRealTradingUser] = useState(false)
  const [guardrailPopup, setGuardrailPopup] = useState<{ type: 'BLOCK' | 'COOLDOWN' | 'BAN'; reason: string } | null>(null)
  const [combinedPnlOpen, setCombinedPnlOpen] = useState(false)
  const [autoStartSnapshots, setAutoStartSnapshots] = useState(loadAutoStartEventSnapshots)
  const [stepwiseLabelingPopup, setStepwiseLabelingPopup] = useState(loadStepwiseLabelingPopupEnabled)
  const [patternAlerts, setPatternAlerts] = useState<PatternAlert[]>([])

  // ── Trade Analysis modal ────────────────────────────────────────────────────
  const [showAnalysis, setShowAnalysis] = useState(false)

  // ── Account name backfill popup for old accounts ─────────────────────────────
  const [showAccountNamePopup, setShowAccountNamePopup] = useState(!authUser.accountName)
  const [backfillAccountName, setBackfillAccountName] = useState('')
  const [backfillSubmitting, setBackfillSubmitting] = useState(false)
  const handleBackfillSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!backfillAccountName.trim()) return
    setBackfillSubmitting(true)
    try {
      const me = await api.setAccountName(backfillAccountName.trim())
      setAuthUser(prev => prev ? { ...prev, accountName: me.account_name ?? undefined } : prev)
      setShowAccountNamePopup(false)
    } catch {
      // ignore
    } finally {
      setBackfillSubmitting(false)
    }
  }

  // ── Pattern Library page ─────────────────────────────────────────────────────
  const [showPatternLibrary, setShowPatternLibrary] = useState(false)
  const [showChartStructures, setShowChartStructures] = useState(false)
  const [sessionControlsVisible, setSessionControlsVisible] = useState(true)
  // Stepwise trade labeling: compute completed round-trips at bar boundary.
  // Uses a ref to track net qty at the PREVIOUS bar end, so we detect the
  // net-qty→zero transition that happened during the just-completed bar.
  // All computation is in a SINGLE effect (bar_paused) — no timing gap
  // between trades-update and bar_paused effects across React batches.
  const [stepwiseLabels, setStepwiseLabels] = useState<{ right: string; session_id: string }[] | null>(null)
  const lastNetQtyRef = useRef({ eq: 0, ce: 0, pe: 0 })

  // ── Price-pick state ────────────────────────────────────────────────────────
  const [pricePickOrderId, setPricePickOrderId] = useState<string | null>(null)
  const [injectedEditPrice, setInjectedEditPrice] = useState<{ orderId: string; price: number } | null>(null)
  const [tpPickActive, setTpPickActive] = useState(false)
  const [injectedTpPrice, setInjectedTpPrice] = useState<number | null>(null)
  const [utpPickActive, setUtpPickActive] = useState(false)
  const [injectedUtpPrice, setInjectedUtpPrice] = useState<number | null>(null)
  const [lpPickActive, setLpPickActive] = useState(false)
  const [injectedLpPrice, setInjectedLpPrice] = useState<number | null>(null)

  useEffect(() => {
    if (!localStorage.getItem('user')) {
      localStorage.setItem('user', JSON.stringify(FIXED_USER))
    }
    // Check real trading access on mount
    api.checkRealTradingAccess().then(r => setIsRealTradingUser(r.has_access)).catch(() => {})
  }, [])

  // Auto-show session controls when session ends/stops
  useEffect(() => {
    if (sim.sessionState === 'idle' || sim.sessionState === 'ended') {
      setSessionControlsVisible(true)
      setStepwiseLabels(null)
    }
  }, [sim.sessionState])

  // Reset net qty tracking on new session start
  useEffect(() => {
    if (sim.sessionState === 'running' && sim.stepwise) {
      lastNetQtyRef.current = { eq: 0, ce: 0, pe: 0 }
      setStepwiseLabels(null)
    }
  }, [sim.sessionState, sim.stepwise])

  // At each bar boundary, compute net qty per right from ALL trades and
  // diff against previous bar end to find completed round-trips.
  useEffect(() => {
    if (!sim.stepwise || !sim.barPaused) return
    if (!sim.sessionId) return

    const trades = sim.trades ?? []
    const eqQty = trades.filter(t => !t.right).reduce((sum, t) => sum + (t.side === 'BUY' ? t.quantity : -t.quantity), 0)
    const ceQty = trades.filter(t => t.right === 'CE').reduce((sum, t) => sum + (t.side === 'BUY' ? t.quantity : -t.quantity), 0)
    const peQty = trades.filter(t => t.right === 'PE').reduce((sum, t) => sum + (t.side === 'BUY' ? t.quantity : -t.quantity), 0)
    const prev = lastNetQtyRef.current

    const completed: { right: string; session_id: string }[] = []
    if (prev.eq > 0 && eqQty === 0) completed.push({ right: '', session_id: sim.sessionId })
    if (prev.ce > 0 && ceQty === 0) completed.push({ right: 'CE', session_id: sim.sessionId })
    if (prev.pe > 0 && peQty === 0) completed.push({ right: 'PE', session_id: sim.sessionId })

    lastNetQtyRef.current = { eq: eqQty, ce: ceQty, pe: peQty }

    if (completed.length > 0) {
      setStepwiseLabels(completed)
    }
  }, [sim.barPaused, sim.stepwise, sim.sessionId, sim.trades])

  // ── Wrapped nextBar: show popup instead of advancing ───────────────────────
  const wrappedNextBar = useCallback(async () => {
    if (stepwiseLabels) return // popup already showing
    await sim.nextBar()
  }, [sim.nextBar, stepwiseLabels])

  // ── Pane state ──────────────────────────────────────────────────────────────
  const [panes, setPanes] = useState<PaneConfig[]>(DEFAULT_EQUITY_PANES)
  const [layoutPreset, setLayoutPreset] = useState<LayoutPreset>(2)
  const [activePaneId, setActivePaneId] = useState<number | null>(1)
  const [maximizedPaneId, setMaximizedPaneId] = useState<number | null>(null)

  // ── Options mode state ──────────────────────────────────────────────────────
  const [instrumentType, setInstrumentType] = useState<'equity' | 'options'>('equity')
  const [optionsReady, setOptionsReady] = useState<OptionsReadyConfig | null>(null)
  // Add-pane UI state
  const [addPaneType, setAddPaneType] = useState<'equity' | 'CE' | 'PE'>('equity')
  const [addInterval, setAddInterval] = useState(15)
  const [addOffset, setAddOffset] = useState(0)

  // ── Chart container height ──────────────────────────────────────────────────
  const chartColumnRef = useRef<HTMLDivElement>(null)
  const [columnHeight, setColumnHeight] = useState(window.innerHeight - 160)

  useEffect(() => {
    const obs = new ResizeObserver(entries => setColumnHeight(entries[0].contentRect.height))
    if (chartColumnRef.current) obs.observe(chartColumnRef.current)
    return () => obs.disconnect()
  }, [])

  // ── Options ready: switch to 3-pane options default ─────────────────────────
  const handleOptionsReady = useCallback((cfg: OptionsReadyConfig | null) => {
    setOptionsReady(cfg)
    if (cfg) {
      setInstrumentType('options')
      setLayoutPreset(3)
      setPanes([
        { id: 1, type: 'equity', intervalMinutes: 3 },
        makeOptionsPane('CE', cfg.ceStrike, cfg.expiry),
        makeOptionsPane('PE', cfg.peStrike, cfg.expiry),
      ])
      setActivePaneId(null)  // user must click a CE/PE pane to trade
    } else {
      setInstrumentType('equity')
      setLayoutPreset(2)
      setPanes(DEFAULT_EQUITY_PANES)
      setActivePaneId(1)
    }
  }, [])

  // ── Layout preset change ────────────────────────────────────────────────────
  const handleLayoutChange = useCallback((preset: LayoutPreset) => {
    setLayoutPreset(preset)
    setPanes(p => defaultPanesForLayout(preset, p))
  }, [])

  // ── Add pane ────────────────────────────────────────────────────────────────
  const addPane = useCallback(() => {
    // Allow adding CE/PE panes when optionsReady is set OR when a running options session provides the expiry
    const effectiveExpiry = optionsReady?.expiry ?? sim.sessionExpiry
    const isOptionsAdd = (instrumentType === 'options' || sim.sessionInstrumentType === 'options')
                         && addPaneType !== 'equity'
                         && !!effectiveExpiry
    if (isOptionsAdd && effectiveExpiry) {
      const interval = { NIFTY: 50, BSESEN: 100, RELIND: 5, TATMOT: 5, TATPOW: 5 }[sim.symbol] ?? 50
      const basePrice = sim.currentPrice > 0 ? sim.currentPrice : (optionsReady?.underlyingPrice ?? 0)
      const currentAtm = Math.round(basePrice / interval) * interval
      // OTM direction: positive offset = higher strikes for CE, lower for PE
      const directedOffset = addPaneType === 'PE' ? -addOffset : addOffset
      const strike = currentAtm + directedOffset * interval
      const right = addPaneType as 'CE' | 'PE'
      const liveFromTs = sim.latestEquityTick?.time ?? undefined
      const newPane = { ...makeOptionsPane(right, strike, effectiveExpiry), liveFromTs }
      setPanes(p => [...p, newPane])

      if (sim.sessionId && (sim.sessionState === 'running' || sim.sessionState === 'paused')) {
        api.updatePaneStrike(sim.sessionId, right, strike)
          .then(() => {
            sim.updateSessionStrike(right, strike)
            // Increment pane's reloadKey now that the backend has cached the data,
            // so the Chart re-fetches historical candles for the new strike.
            setPanes(p => p.map(x => x.id === newPane.id ? { ...x, reloadKey: (x.reloadKey ?? 0) + 1 } : x))
          })
          .catch((err: unknown) => console.error('Failed to update streaming strike:', err))
      }
    } else {
      setPanes(p => [...p, makeEquityPane(addInterval)])
    }
  }, [instrumentType, addPaneType, addInterval, addOffset, optionsReady, sim.symbol,
      sim.currentPrice, sim.latestEquityTick, sim.sessionId, sim.sessionState,
      sim.sessionInstrumentType, sim.sessionExpiry, sim.updateSessionStrike])

  const removePane = useCallback((id: number) => {
    setPanes(p => {
      const next = p.filter(x => x.id !== id)
      return next.length === 0 ? p : next  // keep at least one pane
    })
    setActivePaneId(a => a === id ? null : a)
    setMaximizedPaneId(m => m === id ? null : m)
  }, [])

  const swapPanes = useCallback((indexA: number, indexB: number) => {
    setPanes(p => {
      if (indexA < 0 || indexA >= p.length || indexB < 0 || indexB >= p.length) return p
      if (indexA === indexB) return p
      const next = [...p]
      ;[next[indexA], next[indexB]] = [next[indexB], next[indexA]]
      return next
    })
  }, [])

  // ── Active pane derivations ─────────────────────────────────────────────────
  const activePane = panes.find(p => p.id === activePaneId) ?? null
  const activeRight: 'CE' | 'PE' | null = activePane?.type === 'options' ? (activePane.right ?? null) : null

  // For equity sessions: any pane is the "active trading pane"
  const tradingActiveRight = instrumentType === 'equity' ? undefined : activeRight ?? undefined

  const activeLabel = (() => {
    if (!activePane) return undefined
    if (activePane.type === 'options' && activePane.right)
      return `${sim.symbol} ${activePane.right} ${activePane.strike} | ${activePane.expiry}`
    return undefined
  })()

  // Price shown in TradePanel = active contract price (or equity)
  const tradePanelPrice = (() => {
    if (instrumentType === 'options') {
      if (activeRight === 'CE') return sim.currentPriceCE
      if (activeRight === 'PE') return sim.currentPricePE
      return sim.currentPrice  // underlying pane selected — show index price
    }
    return sim.currentPrice
  })()

  // Position shown in TradePanel
  const tradePanelPosition = (() => {
    if (instrumentType === 'options') {
      if (activeRight === 'CE') return sim.positionCE
      if (activeRight === 'PE') return sim.positionPE
      return { symbol: sim.symbol, quantity: 0, avg_entry_price: 0, side: 'FLAT' as const, entry_commission: 0 }
    }
    return sim.position
  })()

  // TradePanel P&L = active contract only (options) or total (equity)
  const tradePanelPnl = (() => {
    if (instrumentType === 'options') {
      if (activeRight === 'CE') return sim.pnlCE
      if (activeRight === 'PE') return sim.pnlPE
      return sim.pnlOptions
    }
    return sim.pnlEquity
  })()

  // ── Per-pane tick routing ────────────────────────────────────────────────────
  // Each tick type has its own state field so React batching doesn't drop earlier
  // ticks when equity + CE + PE all arrive within the same render cycle.
  // CE and PE may stream at different strikes (when OTM offset != 0), so each is
  // checked against its own per-right session strike. A pane with a non-matching
  // strike receives no live ticks and shows history only.
  const getTickForPane = useCallback((pane: PaneConfig) => {
    if (pane.type === 'equity') return sim.latestEquityTick
    if (pane.right === 'CE') {
      if (sim.sessionStrikeCE !== null && pane.strike !== sim.sessionStrikeCE) return null
      return sim.latestCETick
    }
    if (pane.right === 'PE') {
      if (sim.sessionStrikePE !== null && pane.strike !== sim.sessionStrikePE) return null
      return sim.latestPETick
    }
    return null
  }, [sim.latestEquityTick, sim.latestCETick, sim.latestPETick, sim.sessionStrikeCE, sim.sessionStrikePE])

  const getCompletedBarForPane = useCallback((pane: PaneConfig) => {
    if (pane.type === 'equity') return sim.lastCompletedBarEquity
    if (pane.right === 'CE') return sim.lastCompletedBarCE ?? sim.lastCompletedBarEquity
    if (pane.right === 'PE') return sim.lastCompletedBarPE ?? sim.lastCompletedBarEquity
    return null
  }, [sim.lastCompletedBarEquity, sim.lastCompletedBarCE, sim.lastCompletedBarPE])

  // ── SSE at app level ─────────────────────────────────────────────────────────
  const handleSSEMessage = useCallback((event: Record<string, unknown>) => {
    if (event.type === 'tick') {
      sim.setLatestTick(event as unknown as Parameters<typeof sim.setLatestTick>[0])
    } else if (event.type === 'session_ended') {
      sim.handleSessionEnded()
      setGuardrailPopup(null)
    } else if (event.type === 'guardrail_activated') {
      const grType = (event.guardrail_type as string ?? 'BLOCK').toUpperCase() as 'BLOCK' | 'COOLDOWN' | 'BAN'
      const grReason = (event.reason as string) ?? 'Trading paused by guardrail'
      setGuardrailPopup({ type: grType, reason: grReason })
    } else if (event.type === 'order_filled') {
      sim.handleOrderFilled(event.order_id as string, event.right as string | null | undefined)
      captureSnapshot({
        type: 'order_filled',
        description: `${event.side} FILLED @ ${event.filled_price}${event.right ? ` ${event.right}` : ''}`,
        details: {
          side: event.side,
          filled_price: event.filled_price,
          trigger_price: event.trigger_price,
          quantity: event.quantity,
          right: event.right,
        },
      })
    } else if (event.type === 'order_placed') {
      // Strategy-placed orders (e.g. AutoStop TARGET) surfaced so the UI shows them
      // in the open orders panel and the SL tab can be used after they fill.
      sim.addOpenOrder(event as unknown as import('./services/api').Order)
    } else if (event.type === 'order_cancelled') {
      // Kotak rejected a forwarded order — remove it from open orders and credit wallet back
      sim.handleOrderCancelled(event.order_id as string)
    } else if (event.type === 'order_converted') {
      sim.handleOrderConverted(event.order_id as string, event.new_order_type as string, event.trigger_price as number, event.limit_price as number, event.is_stoploss as boolean)
    } else if (event.type === 'strategy_completed') {
      setRunningStrategies(prev => prev.filter(s => s.strategy_id !== (event.strategy_id as string)))
    } else if (event.type === 'broker_error') {
      setBrokerError(event.message as string)
    } else if (event.type === 'new_trade') {
      sim.addTradeFromSSE(event as unknown as import('./services/api').Trade)
    } else if (event.type === 'pattern_alert') {
      const alert: PatternAlert = {
        id: Date.now() + Math.random(),
        pattern: (event.pattern as string) ?? '',
        category: (event.category as string) ?? 'info',
        title: (event.title as string) ?? 'Pattern Detected',
        severity: (event.severity as string) ?? 'info',
        description: (event.description as string) ?? '',
        trade_suggestion: (event.trade_suggestion as string | null) ?? null,
      }
      setPatternAlerts(prev => [...prev.slice(-2), alert])
    } else if (event.type === 'bar_paused') {
      const mkCandle = (o: unknown, h: unknown, l: unknown, c: unknown, t: unknown) =>
        (o != null && h != null && l != null && c != null && t != null)
          ? { time: t as number, open: o as number, high: h as number, low: l as number, close: c as number }
          : null
      const eqBar = mkCandle(event.bar_open, event.bar_high, event.bar_low, event.bar_close, event.bar_time)
      const ceBar = mkCandle(event.bar_open_ce, event.bar_high_ce, event.bar_low_ce, event.bar_close_ce, event.bar_time)
      const peBar = mkCandle(event.bar_open_pe, event.bar_high_pe, event.bar_low_pe, event.bar_close_pe, event.bar_time)
      sim.handleBarPaused(event.bar_index as number, event.total_bars as number, eqBar, ceBar, peBar)
    }
  }, [sim.setLatestTick, sim.handleSessionEnded, sim.handleOrderFilled, sim.handleOrderCancelled, sim.addOpenOrder, sim.addTradeFromSSE, sim.handleBarPaused, setGuardrailPopup, setRunningStrategies, captureSnapshot])

  useSSE(sim.sseUrl, handleSSEMessage)

  const handleStart = useCallback(async (startTime: string, speed: number, instrumentConfig: InstrumentConfig) => {
    setRunningStrategies([])
    await sim.startSession(startTime, speed, {
      ...instrumentConfig,
      brokerage_per_order: brokeragePerOrder,
      strategy_interval_secs: stratIntervalSecs,
    })
    if (autoStartSnapshots) startSnapshots()
  }, [sim.startSession, brokeragePerOrder, stratIntervalSecs, autoStartSnapshots, startSnapshots])

  // ── Price pick: chart clicked in pick mode ───────────────────────────────────
  const handleChartPriceSelect = useCallback((price: number) => {
    if (tpPickActive) {
      setInjectedTpPrice(price)
      setTpPickActive(false)
    } else if (utpPickActive) {
      setInjectedUtpPrice(price)
      setUtpPickActive(false)
    } else if (lpPickActive) {
      setInjectedLpPrice(price)
      setLpPickActive(false)
    } else if (pricePickOrderId) {
      setInjectedEditPrice({ orderId: pricePickOrderId, price })
      setPricePickOrderId(null)
    }
  }, [pricePickOrderId, tpPickActive, utpPickActive, lpPickActive])

  // ── Strategy callbacks ────────────────────────────────────────────────────────
  const handleStartStrategy = useCallback(async (
    strategyType: StartStrategyRequest['strategy_type'],
    right: 'CE' | 'PE' | null,
    opts: {
      quantity?: number
      fundsRatioPct?: number
      direction?: 'BUY' | 'SELL'
      onlyInProfit?: boolean
      targetProfitValue?: number
      targetProfitIsPct?: boolean
      lockProfitValue?: number
      lockProfitIsPct?: boolean
    },
  ) => {
    if (!sim.sessionId) return
    const resp = await api.startStrategy({
      session_id: sim.sessionId,
      strategy_type: strategyType,
      right: right ?? undefined,
      quantity: opts.quantity,
      funds_ratio_pct: opts.fundsRatioPct,
      direction: opts.direction,
      autostop_trigger_type: autostopTriggerType,
      autostop_deviation_pct: autostopDeviationPct,
      only_in_profit: opts.onlyInProfit ?? aggrSlOnlyInProfit,
      breakeven_mode: breakevenMode,
      target_profit_value: opts.targetProfitValue,
      target_profit_is_pct: opts.targetProfitIsPct ?? false,
      target_profit_buffer_ticks: targetProfitBufferTicks,
      lock_profit_value: opts.lockProfitValue,
      lock_profit_is_pct: opts.lockProfitIsPct ?? false,
    })
    setRunningStrategies(prev => [...prev, resp])
  }, [sim.sessionId, autostopTriggerType, autostopDeviationPct, breakevenMode, targetProfitBufferTicks, aggrSlOnlyInProfit])

  const handleCancelAllStrategies = useCallback(async () => {
    if (!sim.sessionId) return
    await api.cancelAllStrategies(sim.sessionId)
    setRunningStrategies([])
  }, [sim.sessionId])

  const handleCancelStrategy = useCallback(async (strategyId: string) => {
    if (!sim.sessionId) return
    await api.cancelStrategy(strategyId, sim.sessionId)
    setRunningStrategies(prev => prev.filter(s => s.strategy_id !== strategyId))
  }, [sim.sessionId])

  const handleUpdateStrategyPrice = useCallback(async (strategyId: string, price: number) => {
    if (!sim.sessionId) return
    await api.updateStrategyPrice(strategyId, sim.sessionId, price)
    setRunningStrategies(prev => prev.map(s =>
      s.strategy_id === strategyId ? { ...s, triggered: false } : s
    ))
  }, [sim.sessionId])

  const handleBulkUpdateSL = useCallback(async (triggerPrice: number, right: string | null) => {
    if (!sim.sessionId) return { updated: 0, orders: [] }
    const res = await api.bulkUpdateSL(sim.sessionId, triggerPrice, right)
    if (res.orders.length > 0) {
      sim.bulkUpdateOrders(res.orders)
    }
    return res
  }, [sim.sessionId, sim.bulkUpdateOrders])

  // Net session P&L = gross dayPnl minus per-trade commissions (computed by backend)
  const netDayPnl = sim.dayPnl - sim.trades.reduce((s, t) => s + (t.commission ?? 0), 0)
  // Total day P&L includes realized P&L from previous sessions for same user+symbol+date+type
  const totalDayPnl = netDayPnl + sim.prevDayPnl

  // ── Trades filtered per pane for markers ─────────────────────────────────────
  const getTradesForPane = useCallback((pane: PaneConfig) => {
    if (pane.type === 'equity') return sim.trades.filter(t => !t.right || t.underlying_price !== undefined)
    return sim.trades.filter(t => t.right === pane.right && t.strike === pane.strike)
  }, [sim.trades])

  const getOrdersForPane = useCallback((pane: PaneConfig): Order[] => {
    if (pane.type === 'equity') return sim.openOrders.filter(o => !o.right)
    return sim.openOrders.filter(o =>
      o.right === pane.right && (o.strike == null || o.strike === pane.strike)
    )
  }, [sim.openOrders])

  const getPositionForPane = useCallback((pane: PaneConfig) => {
    if (pane.type === 'equity') return sim.position
    if (pane.right === 'CE') return sim.positionCE
    if (pane.right === 'PE') return sim.positionPE
    return sim.position
  }, [sim.position, sim.positionCE, sim.positionPE])

  const getPnlForPane = useCallback((pane: PaneConfig) => {
    if (pane.type === 'equity') {
      // Show equity P&L only on the first equity pane
      const firstEq = panes.find(p => p.type === 'equity')
      return pane.id === firstEq?.id ? sim.pnlEquity : 0
    }
    if (pane.right === 'CE') return sim.pnlCE
    if (pane.right === 'PE') return sim.pnlPE
    return 0
  }, [sim.pnlEquity, sim.pnlCE, sim.pnlPE, panes])

  // ── Layout rendering helpers ──────────────────────────────────────────────────
  const rowHeight = Math.max(160, Math.floor((columnHeight - 36) / 2 * 0.966))

  const renderPane = (pane: PaneConfig, height: number, style?: React.CSSProperties) => {
    const isMaximized = maximizedPaneId === pane.id
    const paneIndex = panes.findIndex(p => p.id === pane.id)

    // Compute valid swap targets based on layout and position
    const swapTargets: { dir: string; onClick: () => void }[] = []
    if (panes.length > 1 && paneIndex >= 0) {
      const add = (dir: string, target: number) => {
        swapTargets.push({ dir, onClick: () => swapPanes(paneIndex, target) })
      }
      if (layoutPreset === 4) {
        // 2×2: panes[0]=TL, panes[1]=TR, panes[2]=BL, panes[3]=BR
        if (paneIndex === 0) { add('→', 1); add('↓', 2) }
        else if (paneIndex === 1) { add('←', 0); add('↓', 3) }
        else if (paneIndex === 2) { add('→', 3); add('↑', 0) }
        else if (paneIndex === 3) { add('←', 2); add('↑', 1) }
      } else if (layoutPreset === 3) {
        // Top full-width + 2 bottom: panes[0]=Top, panes[1]=BL, panes[2]=BR
        if (paneIndex === 0) { add('↓', 1) }
        else if (paneIndex === 1) { add('→', 2); add('↑', 0) }
        else if (paneIndex === 2) { add('←', 1); add('↑', 0) }
      } else if (layoutPreset === 2) {
        // Vertical stack: panes[0]=Top, panes[1]=Bottom
        if (paneIndex === 0) { add('↓', 1) }
        else if (paneIndex === 1) { add('↑', 0) }
      }
    }

    return (
      <div key={pane.id} style={{ position: 'relative', minHeight: height, minWidth: 0, ...style }}>
        {panes.length > 1 && !isMaximized && (
          <button
            onClick={e => { e.stopPropagation(); removePane(pane.id) }}
            title="Remove pane"
            style={{
              position: 'absolute', top: 8, right: 8, zIndex: 10,
              background: 'rgba(13,17,23,0.8)', border: 'none',
              color: '#484f58', cursor: 'pointer', fontSize: 13, lineHeight: 1, borderRadius: 4,
              padding: '1px 5px',
            }}
          >✕</button>
        )}
        <Chart
          symbol={sim.symbol}
          tradingDate={sim.date}
          startTime={sim.startTime}
          intervalMinutes={pane.intervalMinutes}
          latestTick={getTickForPane(pane)}
          completedBar={getCompletedBarForPane(pane)}
          height={height}
          paneType={pane.type}
          strike={pane.strike}
          expiry={pane.expiry}
          right={pane.right as 'CE' | 'PE' | undefined}
          liveFromTs={pane.liveFromTs}
          reloadKey={pane.reloadKey ?? 0}
          currentSimTime={sim.latestEquityTick?.time ?? null}
          isActive={pane.id === activePaneId}
          onActivate={() => {
            setActivePaneId(pane.id)
            if ((pricePickOrderId || tpPickActive || utpPickActive || lpPickActive) && pane.id !== activePaneId) {
              setPricePickOrderId(null)
              setTpPickActive(false)
            }
          }}
          trades={getTradesForPane(pane)}
          openOrders={getOrdersForPane(pane)}
          onPriceSelect={(pricePickOrderId || tpPickActive || utpPickActive || lpPickActive) && pane.id === activePaneId ? handleChartPriceSelect : null}
          historicalDays={historicalDays}
          onMaximize={() => setMaximizedPaneId(isMaximized ? null : pane.id)}
          isMaximized={isMaximized}
          swapTargets={swapTargets.length > 0 ? swapTargets : undefined}
          position={getPositionForPane(pane)}
          pnl={getPnlForPane(pane)}
          pnlPctMode={pnlPctMode}
          sessionCapital={sim.sessionCapital}
        />
      </div>
    )
  }

  if (showChartStructures) {
    return <ChartStructures onClose={() => setShowChartStructures(false)} />
  }

  const renderLayout = () => {
    const gap = 4
    const maxH = Math.max(160, columnHeight - 36)

    // Maximize is handled inline per-layout rather than with a separate top-level
    // branch. Keeping the same flex container structure means the pane wrapper div's
    // DOM parent never changes, so React never unmounts/remounts Chart components.
    // Non-maximized panes get display:none — still mounted, liveWindowRef preserved.

    if (layoutPreset === 1) {
      const h = columnHeight - 36
      return panes[0] ? renderPane(panes[0], Math.max(160, h)) : null
    }

    if (layoutPreset === 2) {
      const h = Math.max(160, Math.floor((columnHeight - 36 - gap) / 2 * 0.9))
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap }}>
          {panes.slice(0, 2).map(p => {
            if (maximizedPaneId === null) return renderPane(p, h)
            return renderPane(p, maxH, p.id === maximizedPaneId ? undefined : { display: 'none' })
          })}
        </div>
      )
    }

    if (layoutPreset === 3) {
      // Row 1: full-width top pane; Row 2: two half-width panes
      if (maximizedPaneId !== null) {
        const maxInRow2 = panes[1]?.id === maximizedPaneId || panes[2]?.id === maximizedPaneId
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap }}>
            {panes[0] && renderPane(panes[0], maxH, panes[0].id === maximizedPaneId ? undefined : { display: 'none' })}
            <div style={{ display: maxInRow2 ? 'flex' : 'none', gap }}>
              {panes[1] && renderPane(panes[1], maxH, panes[1].id === maximizedPaneId ? { flex: 1 } : { flex: 1, display: 'none' })}
              {panes[2] && renderPane(panes[2], maxH, panes[2].id === maximizedPaneId ? { flex: 1 } : { flex: 1, display: 'none' })}
            </div>
          </div>
        )
      }
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap }}>
          {panes[0] && renderPane(panes[0], rowHeight)}
          <div style={{ display: 'flex', gap }}>
            {panes[1] && renderPane(panes[1], rowHeight, { flex: 1 })}
            {panes[2] && renderPane(panes[2], rowHeight, { flex: 1 })}
          </div>
        </div>
      )
    }

    // layout 4: 2×2 grid
    if (maximizedPaneId !== null) {
      const maxInRow1 = panes[0]?.id === maximizedPaneId || panes[1]?.id === maximizedPaneId
      const maxInRow2 = panes[2]?.id === maximizedPaneId || panes[3]?.id === maximizedPaneId
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap }}>
          <div style={{ display: maxInRow1 ? 'flex' : 'none', gap }}>
            {panes[0] && renderPane(panes[0], maxH, panes[0].id === maximizedPaneId ? { flex: 1 } : { flex: 1, display: 'none' })}
            {panes[1] && renderPane(panes[1], maxH, panes[1].id === maximizedPaneId ? { flex: 1 } : { flex: 1, display: 'none' })}
          </div>
          <div style={{ display: maxInRow2 ? 'flex' : 'none', gap }}>
            {panes[2] && renderPane(panes[2], maxH, panes[2].id === maximizedPaneId ? { flex: 1 } : { flex: 1, display: 'none' })}
            {panes[3] && renderPane(panes[3], maxH, panes[3].id === maximizedPaneId ? { flex: 1 } : { flex: 1, display: 'none' })}
          </div>
        </div>
      )
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap }}>
        <div style={{ display: 'flex', gap }}>
          {panes[0] && renderPane(panes[0], rowHeight, { flex: 1 })}
          {panes[1] && renderPane(panes[1], rowHeight, { flex: 1 })}
        </div>
        <div style={{ display: 'flex', gap }}>
          {panes[2] && renderPane(panes[2], rowHeight, { flex: 1 })}
          {panes[3] && renderPane(panes[3], rowHeight, { flex: 1 })}
        </div>
      </div>
    )
  }

  const idle = sim.sessionState === 'idle' || sim.sessionState === 'ended'

  if (showPatternLibrary) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        {/* Minimal header for Pattern Library */}
        <div style={{
          padding: '8px 16px', background: '#161b22', borderBottom: '1px solid #30363d',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#58a6ff' }}>TradeMatangi</span>
          <button
            onClick={() => setShowPatternLibrary(false)}
            style={{
              background: '#21262d', border: '1px solid #30363d',
              color: '#8b949e', borderRadius: 6, padding: '4px 10px',
              fontSize: 12, cursor: 'pointer',
            }}
          >
            ← Back to Trading
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: '#484f58' }}>{authUser.accountName || authUser.email}</span>
          <button onClick={onLogout}
            style={{ background: 'none', border: '1px solid #30363d', color: '#8b949e', borderRadius: 6, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}>
            Sign out
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <PatternLibrary />
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '10px 20px', background: '#161b22', borderBottom: '1px solid #30363d',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: '#58a6ff' }}>TradeMatangi</span>
        <div style={{ flex: 1 }} />
        {sim.sessionState !== 'idle' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: '#161b22', border: '1px solid #30363d',
            borderRadius: 6, padding: '4px 10px', fontSize: 12,
          }}>
            <span style={{ color: '#8b949e' }}>Day P&L</span>
            <span style={{
              fontWeight: 700, fontVariantNumeric: 'tabular-nums',
              color: totalDayPnl > 0 ? '#26a641' : totalDayPnl < 0 ? '#f85149' : '#8b949e',
            }}>
              {totalDayPnl >= 0 ? '+' : ''}{totalDayPnl.toFixed(2)}
            </span>
            {sim.prevDayPnl !== 0 && (
              <span style={{ color: '#484f58', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
                (prev {sim.prevDayPnl >= 0 ? '+' : ''}{sim.prevDayPnl.toFixed(2)})
              </span>
            )}
          </div>
        )}
        {(sim.sessionState === 'running' || sim.sessionState === 'paused') && !guardrailPopup?.type && (
          <button
            onClick={async () => {
              if (!sim.sessionId) return
              try {
                const result = await api.triggerBlock(sim.sessionId)
                setGuardrailPopup({ type: 'BLOCK', reason: result.reason })
              } catch (e) {
                const msg = e instanceof Error ? e.message : 'Block failed'
                if (msg.includes('BAN')) setGuardrailPopup({ type: 'BAN', reason: msg })
              }
            }}
            title="Trigger BLOCK guardrail — pause trading for n bars"
            style={{
              background: '#3d1f1f', border: '1px solid #f0883e', color: '#f0883e',
              borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 600,
            }}
          >
            BLOCK
          </button>
        )}
        <WalletWidget date={sim.date} refreshKey={sim.walletRefreshKey} />
        <button
          onClick={() => setShowAnalysis(true)}
          title="Trade Analysis"
          style={{
            background: '#161b22', border: '1px solid #30363d',
            color: '#8b949e', borderRadius: 6, padding: '4px 10px',
            fontSize: 12, cursor: 'pointer',
          }}
        >
          📊 Analysis
        </button>
        <button
          onClick={() => setShowPatternLibrary(p => !p)}
          title="Pattern Library — annotate and study trade setups"
          style={{
            background: showPatternLibrary ? '#1f6feb' : '#161b22',
            border: `1px solid ${showPatternLibrary ? '#1f6feb' : '#30363d'}`,
            color: showPatternLibrary ? '#fff' : '#8b949e',
            borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
          }}
        >
          📚 Patterns
        </button>
        <button
          onClick={() => setShowChartStructures(p => !p)}
          title="Chart Structures — browse daily market structure classifications"
          style={{
            background: showChartStructures ? '#1f6feb' : '#161b22',
            border: `1px solid ${showChartStructures ? '#1f6feb' : '#30363d'}`,
            color: showChartStructures ? '#fff' : '#8b949e',
            borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
          }}
        >
          📊 Structures
        </button>
        {/* Show/hide session controls — only when session is active */}
        {(sim.sessionState === 'running' || sim.sessionState === 'paused') && (
          <>
            {!sessionControlsVisible && (
              <>
                {sim.sessionState === 'running' && !sim.stepwise && (
                  <button onClick={sim.pauseSession} style={{
                    background: '#161b22', border: '1px solid #30363d', color: '#8b949e',
                    borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
                  }}>⏸ Pause</button>
                )}
                {sim.sessionState === 'paused' && (
                  <button onClick={sim.resumeSession} style={{
                    background: '#161b22', border: '1px solid #30363d', color: '#8b949e',
                    borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
                  }}>▶ Resume</button>
                )}
                <button onClick={sim.stopSession} style={{
                  background: '#3d1010', border: '1px solid #8b1a1a', color: '#f85149',
                  borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
                }}>■ Stop</button>
              </>
            )}
            <button
              onClick={() => setSessionControlsVisible(v => !v)}
              title={sessionControlsVisible ? 'Hide session controls for more chart space' : 'Show session controls'}
              style={{
                background: '#161b22', border: '1px solid #30363d',
                color: '#8b949e', borderRadius: 6, padding: '4px 10px',
                fontSize: 12, cursor: 'pointer',
              }}
            >
              {sessionControlsVisible ? '▲ Controls' : '▼ Controls'}
            </button>
          </>
        )}
        {/* Recording + Snapshot controls — only shown when a session is active */}
        {(sim.sessionState === 'running' || sim.sessionState === 'paused') && sim.sessionId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}>
            {/* Dropdown toggle */}
            <button
              onClick={() => setRecDropdownOpen(v => !v)}
              title="Recording & Snapshot options"
              style={{
                background: '#161b22', border: '1px solid #30363d',
                color: '#8b949e', borderRadius: 6, padding: '4px 10px',
                fontSize: 12, cursor: 'pointer', fontWeight: 600,
              }}
            >
              📸 REC ▼
            </button>
            {/* Dropdown menu */}
            {recDropdownOpen && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, zIndex: 100,
                background: '#161b22', border: '1px solid #30363d',
                borderRadius: 6, padding: '4px 0', minWidth: 160,
                marginTop: 4, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              }}>
                {recordingState === 'idle' && (
                  <button
                    onClick={() => {
                      setRecDropdownOpen(false)
                      const filename = `TradeMatangi_${sim.symbol}_${sim.date}_${sim.sessionType}.webm`
                      startRecording(filename)
                    }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      background: 'none', border: 'none',
                      color: '#f85149', padding: '6px 12px',
                      fontSize: 12, cursor: 'pointer',
                    }}
                  >
                    ● Screen Recording
                  </button>
                )}
                <button
                  onClick={() => {
                    setRecDropdownOpen(false)
                    if (snapshotActive) stopSnapshots()
                    else startSnapshots()
                  }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    background: 'none', border: 'none',
                    color: snapshotActive ? '#3fb950' : '#d29922',
                    padding: '6px 12px',
                    fontSize: 12, cursor: 'pointer',
                  }}
                >
                  {snapshotActive ? '⏹' : '📸'} Event Snapshot
                </button>
              </div>
            )}
            {/* Screen recording active controls */}
            {(recordingState === 'recording' || recordingState === 'paused') && (
              <>
                <span style={{
                  fontSize: 14,
                  color: recordingState === 'recording' ? '#f85149' : '#d29922',
                  animation: recordingState === 'recording' ? 'recBlink 1s step-start infinite' : 'none',
                }}>
                  {recordingState === 'recording' ? '●' : '⏸'}
                </span>
                {recordingState === 'recording' ? (
                  <button onClick={pauseRecording} title="Pause recording"
                    style={{
                      background: '#21262d', border: '1px solid #30363d',
                      color: '#c9d1d9', borderRadius: 6, padding: '4px 8px',
                      fontSize: 12, cursor: 'pointer',
                    }}>
                    ⏸ Pause
                  </button>
                ) : (
                  <button onClick={resumeRecording} title="Resume recording"
                    style={{
                      background: '#21262d', border: '1px solid #30363d',
                      color: '#c9d1d9', borderRadius: 6, padding: '4px 8px',
                      fontSize: 12, cursor: 'pointer',
                    }}>
                    ▶ Resume
                  </button>
                )}
                <button onClick={stopRecording} title="Stop recording and save file"
                  style={{
                    background: '#3d1010', border: '1px solid #8b1a1a',
                    color: '#f85149', borderRadius: 6, padding: '4px 8px',
                    fontSize: 12, cursor: 'pointer',
                  }}>
                  ⏹ Stop
                </button>
              </>
            )}
            {recordingState === 'requesting' && (
              <button disabled
                style={{
                  background: '#21262d', border: '1px solid #30363d',
                  color: '#484f58', borderRadius: 6, padding: '4px 10px',
                  fontSize: 12, cursor: 'not-allowed',
                }}>
                Requesting…
              </button>
            )}
            {/* Snapshot active indicator */}
            {snapshotActive && (
              <span style={{ fontSize: 11, color: '#3fb950', fontWeight: 600 }}>📸 Snapping</span>
            )}
            {recordingError && (
              <span style={{ fontSize: 11, color: '#f85149' }}>{recordingError}</span>
            )}
          </div>
        )}
        <SettingsModal
          date={sim.date}
          isAdmin={authUser.isAdmin}
          isRealTradingUser={isRealTradingUser}
          sessionActive={sim.sessionState === 'running' || sim.sessionState === 'paused'}
          onWalletReset={sim.incrementWalletRefreshKey}
          onFundsRatioChange={(mode, ratios) => { setFundsRatioMode(mode); setFundsRatios(ratios) }}
          onTargetDeviationChange={setTargetDeviationPct}
          onBrokerageChange={setBrokeragePerOrder}
          onStrategySettingsChange={(intervalSecs, triggerType, deviationPct, bkMode, bufTicks, onlyInProfit) => {
            setStratIntervalSecs(intervalSecs)
            setAutostopTriggerType(triggerType)
            setAutostopDeviationPct(deviationPct)
            setBreakevenMode(bkMode)
            setTargetProfitBufferTicks(bufTicks)
            setAggrSlOnlyInProfit(onlyInProfit)
          }}
          onHistoricalDaysChange={setHistoricalDays}
          onPnlPctModeChange={setPnlPctMode}
          onGuardRailSettingsChange={() => {}}
          onAutoStartSnapshotsChange={setAutoStartSnapshots}
          onStepwiseLabelingPopupChange={setStepwiseLabelingPopup}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#484f58' }}>
          <span>{authUser.accountName || authUser.email}</span>
          <button
            onClick={onLogout}
            style={{ background: 'none', border: '1px solid #30363d', color: '#8b949e', borderRadius: 6, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Trade Analysis modal */}
      {showAnalysis && (
        <TradeAnalysis onClose={() => setShowAnalysis(false)} historicalDays={historicalDays} />
      )}

      {/* Stepwise Label Popup — shown at bar boundary when a round-trip completed */}
      {stepwiseLabels && stepwiseLabels.length > 0 && sim.sessionId && stepwiseLabelingPopup && (
        <StepwiseLabelPopup
          sid={sim.sessionId}
          date={sim.date}
          symbol={sim.symbol}
          roundTrips={stepwiseLabels.map(l => ({ right: l.right, pnl: 0 }))}
          onDone={() => setStepwiseLabels(null)}
        />
      )}

      {/* Error banner */}
      {sim.orderError && (
        <div style={{
          background: '#3d1f1f', borderBottom: '1px solid #f85149',
          padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ color: '#f85149', fontSize: 13 }}>{sim.orderError}</span>
          <button
            onClick={sim.clearOrderError}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 14 }}
          >✕</button>
        </div>
      )}

      {/* Session Controls — layout/pane controls injected inline via extraControls */}
      <div style={{ display: sessionControlsVisible ? 'block' : 'none' }}>
      <SessionControls
        sessionState={sim.sessionState}
        currentSymbol={sim.symbol}
        currentDate={sim.date}
        onSymbolChange={sim.updateSymbol}
        onDateChange={sim.updateDate}
        onStart={handleStart}
        onStop={sim.stopSession}
        onPause={sim.pauseSession}
        onResume={sim.resumeSession}
        onOptionsReady={handleOptionsReady}
        isRealTradingUser={isRealTradingUser || authUser.isAdmin}
        stepwise={sim.stepwise}
        barPaused={sim.barPaused}
        barIndex={sim.barIndex}
        totalBars={sim.totalBars}
        onNextBar={wrappedNextBar}
        extraControls={<>
          <div style={{ width: 1, height: 16, background: '#30363d', margin: '0 4px' }} />

          <label style={{ fontSize: 12, color: '#484f58', display: 'flex', alignItems: 'center', gap: 6 }}>
            Layout:
            <select
              value={layoutPreset}
              onChange={e => handleLayoutChange(Number(e.target.value) as LayoutPreset)}
              style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3', borderRadius: 6, padding: '3px 8px', fontSize: 12 }}
            >
              <option value={1}>1 Pane</option>
              <option value={2}>2 Panes</option>
              <option value={3}>3 Panes</option>
              <option value={4}>4 Panes</option>
            </select>
          </label>

          <div style={{ width: 1, height: 16, background: '#30363d', margin: '0 4px' }} />

          <span style={{ fontSize: 12, color: '#484f58' }}>Add:</span>

          {(instrumentType === 'options' || sim.sessionInstrumentType === 'options') && (
            <>
              <select
                value={addPaneType}
                onChange={e => setAddPaneType(e.target.value as 'equity' | 'CE' | 'PE')}
                style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3', borderRadius: 6, padding: '3px 8px', fontSize: 12 }}
              >
                <option value="equity">Underlying</option>
                <option value="CE">Call (CE)</option>
                <option value="PE">Put (PE)</option>
              </select>
              {addPaneType !== 'equity' && (
                <label style={{ fontSize: 12, color: '#8b949e', display: 'flex', alignItems: 'center', gap: 4 }}>
                  OTM:
                  <input
                    type="number" value={addOffset} min={-10} max={10}
                    onChange={e => setAddOffset(parseInt(e.target.value) || 0)}
                    style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3', borderRadius: 6, padding: '3px 6px', fontSize: 12, width: 52 }}
                  />
                </label>
              )}
              {addPaneType === 'equity' && (
                <select
                  value={addInterval}
                  onChange={e => setAddInterval(Number(e.target.value))}
                  style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3', borderRadius: 6, padding: '3px 8px', fontSize: 12 }}
                >
                  {INTERVAL_OPTIONS.map(m => <option key={m} value={m}>{m}m</option>)}
                </select>
              )}
            </>
          )}

          {instrumentType === 'equity' && sim.sessionInstrumentType !== 'options' && (
            <select
              value={addInterval}
              onChange={e => setAddInterval(Number(e.target.value))}
              style={{ background: '#161b22', border: '1px solid #30363d', color: '#e6edf3', borderRadius: 6, padding: '3px 8px', fontSize: 12 }}
            >
              {INTERVAL_OPTIONS.map(m => <option key={m} value={m}>{m}m</option>)}
            </select>
          )}

          <button
            onClick={addPane}
            disabled={(instrumentType === 'options' || sim.sessionInstrumentType === 'options') && addPaneType !== 'equity' && !optionsReady && !sim.sessionExpiry}
            style={{ background: '#21262d', border: '1px solid #30363d', color: '#8b949e', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer' }}
          >+ Add</button>

          {(instrumentType === 'options' || sim.sessionInstrumentType === 'options') && (
            <span style={{ fontSize: 11, color: '#484f58' }}>
              {activeRight ? `Active: ${activeRight}` : 'Click a CE/PE pane to trade'}
            </span>
          )}
        </>}
      />
      </div>

      {/* GuardRail popup */}
      {guardrailPopup && (
        <GuardRailPopup
          type={guardrailPopup.type}
          reason={guardrailPopup.reason}
          onClose={guardrailPopup.type !== 'BAN' ? () => setGuardrailPopup(null) : undefined}
        />
      )}

      {/* Account name backfill popup for old accounts */}
      {showAccountNamePopup && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)',
        }}>
          <div style={{
            width: 380, padding: 28,
            background: '#161b22', border: '1px solid #30363d',
            borderRadius: 12,
          }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#58a6ff', marginBottom: 6 }}>Set Account Name</div>
            <div style={{ fontSize: 13, color: '#8b949e', marginBottom: 18 }}>
              Your account ({authUser.email}) needs a display name. This will be shown in the app instead of your email.
            </div>
            <form onSubmit={handleBackfillSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                type="text"
                value={backfillAccountName}
                onChange={e => setBackfillAccountName(e.target.value)}
                placeholder="Your display name"
                required
                autoFocus
                style={{
                  width: '100%', padding: '10px 12px',
                  background: '#0d1117', border: '1px solid #30363d',
                  borderRadius: 8, color: '#e6edf3', fontSize: 14,
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
              <button
                type="submit"
                disabled={backfillSubmitting}
                style={{
                  width: '100%', padding: '10px', background: '#238636',
                  border: 'none', borderRadius: 8, color: '#ffffff',
                  fontSize: 14, fontWeight: 600,
                  cursor: backfillSubmitting ? 'not-allowed' : 'pointer',
                  opacity: backfillSubmitting ? 0.7 : 1,
                }}
              >
                {backfillSubmitting ? 'Saving…' : 'Save'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Broker error banner (paper trading) */}
      {brokerError && (
        <div style={{
          background: '#3d1c1c', border: '1px solid #f85149', color: '#f85149',
          padding: '6px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>⚠ {brokerError}</span>
          <button
            onClick={() => setBrokerError(null)}
            style={{ background: 'none', border: 'none', color: '#f85149', cursor: 'pointer', marginLeft: 'auto', fontSize: 14 }}
          >✕</button>
        </div>
      )}

      {/* Main content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Chart column */}
        <div
          ref={chartColumnRef}
          style={{ flex: 1, overflow: 'auto', padding: '4px 12px' }}
        >
          {renderLayout()}
        </div>

        {/* Right sidebar */}
        <div style={{
          width: 240, padding: 12, display: 'flex', flexDirection: 'column',
          gap: 12, overflowY: 'auto', borderLeft: '1px solid #30363d',
        }}>
          <TradePanel
            sessionState={sim.sessionState}
            currentPrice={tradePanelPrice}
            position={tradePanelPosition}
            pnl={tradePanelPnl}
            sessionPnl={sim.sessionState !== 'idle' && sim.sessionState !== 'ended' ? netDayPnl : undefined}
            activeRight={instrumentType === 'options' ? activeRight : undefined}
            activeLabel={activeLabel}
            pnlPctMode={pnlPctMode}
            sessionCapital={sim.sessionCapital}
            fundsRatioMode={fundsRatioMode}
          />

          {/* Combined P&L for options (both CE + PE) — collapsible */}
          {instrumentType === 'options' && sim.sessionState !== 'idle' && sim.sessionState !== 'ended' && (
            <div style={{
              background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
              padding: '8px 14px', fontSize: 12,
            }}>
              <div
                onClick={() => setCombinedPnlOpen(o => !o)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
              >
                <span style={{ color: '#8b949e', fontSize: 11 }}>{combinedPnlOpen ? '▾' : '▸'}</span>
                <span style={{ color: '#8b949e' }}>Combined P&L</span>
                <span style={{
                  marginLeft: 'auto', fontWeight: 700, fontSize: 14,
                  color: sim.pnl > 0 ? '#26a641' : sim.pnl < 0 ? '#f85149' : '#8b949e',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {pnlPctMode && sim.sessionCapital > 0
                    ? `${sim.pnl >= 0 ? '+' : ''}${((sim.pnl / sim.sessionCapital) * 100).toFixed(2)}%`
                    : `${sim.pnl >= 0 ? '+' : ''}${sim.pnl.toFixed(2)}`
                  }
                </span>
              </div>
              {combinedPnlOpen && !idle && (
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ color: '#8b949e', fontSize: 11 }}>
                    CE pos: <span style={{ color: '#e6edf3' }}>{sim.positionCE.side}</span>
                    {sim.positionCE.side !== 'FLAT' && ` ${sim.positionCE.quantity}`}
                  </div>
                  <div style={{ color: '#8b949e', fontSize: 11 }}>
                    PE pos: <span style={{ color: '#e6edf3' }}>{sim.positionPE.side}</span>
                    {sim.positionPE.side !== 'FLAT' && ` ${sim.positionPE.quantity}`}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ borderTop: '1px solid #21262d', paddingTop: 12 }}>
            <OrderPanel
              sessionState={sim.sessionState}
              currentPrice={tradePanelPrice}
              openOrders={sim.openOrders}
              position={tradePanelPosition}
              fundsRatioMode={fundsRatioMode}
              fundsRatios={fundsRatios}
              targetDeviationPct={targetDeviationPct}
              instrumentType={instrumentType}
              activeRight={instrumentType === 'options' ? activeRight : undefined}
              positionCE={sim.positionCE}
              positionPE={sim.positionPE}
              runningStrategies={runningStrategies}
              autostopTriggerType={autostopTriggerType}
              autostopDeviationPct={autostopDeviationPct}
              breakevenMode={breakevenMode}
              targetProfitBufferTicks={targetProfitBufferTicks}
              aggrSlOnlyInProfit={aggrSlOnlyInProfit}
              onPlaceOrder={(side, orderType, price, quantity, opts) =>
                sim.placeOrder(side, orderType, price, quantity, {
                  ...opts,
                  ...(tradingActiveRight ? { right: tradingActiveRight } : {}),
                  target_deviation_pct: targetDeviationPct,
                })
              }
              onCancelOrder={sim.cancelOrder}
              onConvertOrder={async (orderId, newOrderType, price) => {
                const updated = await api.convertOrder(sim.sessionId!, orderId, newOrderType, price)
                sim.handleOrderConverted(updated.order_id, updated.order_type, updated.trigger_price, updated.limit_price, updated.is_stoploss)
              }}
              onUpdateOrder={(orderId, triggerPrice, limitPrice) =>
                sim.updateOrder(orderId, triggerPrice, limitPrice, targetDeviationPct)
              }
              onRequestPricePick={orderId => {
                setPricePickOrderId(orderId)
                setInjectedEditPrice(null)
              }}
              injectedEditPrice={injectedEditPrice}
              onRequestTpPick={() => { setTpPickActive(true); setInjectedTpPrice(null) }}
              injectedTpPrice={injectedTpPrice}
              onRequestUtpPick={() => { setUtpPickActive(true); setInjectedUtpPrice(null) }}
              injectedUtpPrice={injectedUtpPrice}
              onRequestLpPick={() => { setLpPickActive(true); setInjectedLpPrice(null) }}
              injectedLpPrice={injectedLpPrice}
              onStartStrategy={handleStartStrategy}
              onCancelAllStrategies={handleCancelAllStrategies}
              onCancelStrategy={handleCancelStrategy}
              onUpdateStrategyPrice={handleUpdateStrategyPrice}
              onBulkUpdateSL={handleBulkUpdateSL}
              onGuardRailBlocked={(type, reason) => setGuardrailPopup({ type, reason })}
              onSnapshotEvent={captureSnapshot}
            />
          </div>
          <TradeHistory
            trades={sim.trades}
            historicalTrades={sim.historicalTrades}
            sessionType={sim.sessionType}
            onRefresh={sim.sessionId ? async () => {
              const result = await api.reconcileKotakOrders(sim.sessionId!)
              // Fetch trades and positions in parallel so P&L recalculates correctly.
              const [trades] = await Promise.all([
                api.getTrades(sim.sessionId!),
                sim.fetchAndUpdatePosition(),  // also bumps walletRefreshKey
              ])
              sim.setTrades(trades)
              const openCount = result.open_orders?.length ?? 0
              if (result.reconciled > 0 || openCount > 0) {
                const parts: string[] = []
                if (result.reconciled > 0) parts.push(`${result.reconciled} fill(s) reconciled`)
                if (openCount > 0) parts.push(`${openCount} order(s) still open on Kotak`)
                setBrokerError(parts.join(' — '))
              }
            } : undefined}
          />
        </div>
      </div>

      <AIChatPanel
        sessionId={sim.sessionId}
        userId={authUser.userId}
        symbol={sim.symbol || null}
        strikeCe={sim.sessionStrikeCE}
        strikePe={sim.sessionStrikePE}
      />

      {/* Pattern alert toasts (experimental feature) */}
      <PatternAlertToast
        alerts={patternAlerts}
        onDismiss={id => setPatternAlerts(prev => prev.filter(a => a.id !== id))}
      />
    </div>
  )
}

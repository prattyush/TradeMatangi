import { useCallback, useEffect, useRef, useState } from 'react'
import Chart, { PaneType } from './components/Chart'
import SessionControls, { OptionsReadyConfig } from './components/SessionControls'
import TradePanel from './components/TradePanel'
import TradeHistory from './components/TradeHistory'
import OrderPanel from './components/OrderPanel'
import WalletWidget from './components/WalletWidget'
import SettingsModal, { loadFundsRatioMode, loadFundsRatios, FundsRatios } from './components/SettingsModal'
import { useSimulation, InstrumentConfig } from './hooks/useSimulation'
import { useSSE } from './hooks/useSSE'

const FIXED_USER = { userId: 'abc12300-0000-0000-0000-000000000001', username: 'abc123' }

// ── Pane config ──────────────────────────────────────────────────────────────
interface PaneConfig {
  id: number
  type: PaneType
  intervalMinutes: number
  // Options fields (only for type='options')
  strike?: number
  expiry?: string
  right?: 'CE' | 'PE'
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
  const sim = useSimulation()
  const [fundsRatioMode, setFundsRatioMode] = useState(loadFundsRatioMode)
  const [fundsRatios, setFundsRatios] = useState<FundsRatios>(loadFundsRatios)

  useEffect(() => {
    if (!localStorage.getItem('user')) {
      localStorage.setItem('user', JSON.stringify(FIXED_USER))
    }
  }, [])

  // ── Pane state ──────────────────────────────────────────────────────────────
  const [panes, setPanes] = useState<PaneConfig[]>(DEFAULT_EQUITY_PANES)
  const [layoutPreset, setLayoutPreset] = useState<LayoutPreset>(2)
  const [activePaneId, setActivePaneId] = useState<number | null>(1)

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
    if (instrumentType === 'options' && addPaneType !== 'equity' && optionsReady) {
      const interval = { NIFTY: 50, RELIND: 5, TATMOT: 5, TATPOW: 5 }[sim.symbol] ?? 50
      // OTM direction: positive offset = higher strikes for CE, lower for PE
      const directedOffset = addPaneType === 'PE' ? -addOffset : addOffset
      const strike = optionsReady.atmStrike + directedOffset * interval
      const right = addPaneType as 'CE' | 'PE'
      setPanes(p => [...p, makeOptionsPane(right, strike, optionsReady.expiry)])
    } else {
      setPanes(p => [...p, makeEquityPane(addInterval)])
    }
  }, [instrumentType, addPaneType, addInterval, addOffset, optionsReady, sim.symbol])

  const removePane = useCallback((id: number) => {
    setPanes(p => {
      const next = p.filter(x => x.id !== id)
      return next.length === 0 ? p : next  // keep at least one pane
    })
    setActivePaneId(a => a === id ? null : a)
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
      return 0
    }
    return sim.currentPrice
  })()

  // Position shown in TradePanel
  const tradePanelPosition = (() => {
    if (instrumentType === 'options') {
      if (activeRight === 'CE') return sim.positionCE
      if (activeRight === 'PE') return sim.positionPE
      return { symbol: sim.symbol, quantity: 0, avg_entry_price: 0, side: 'FLAT' as const }
    }
    return sim.position
  })()

  // TradePanel P&L = active contract only (options) or total (equity)
  const tradePanelPnl = (() => {
    if (instrumentType === 'options') {
      if (activeRight === 'CE') {
        const { positionCE: pos, currentPriceCE: price } = sim
        if (pos.side === 'FLAT' || price === 0) return 0
        return (pos.side === 'LONG' ? 1 : -1) * pos.quantity * (price - pos.avg_entry_price)
      }
      if (activeRight === 'PE') {
        const { positionPE: pos, currentPricePE: price } = sim
        if (pos.side === 'FLAT' || price === 0) return 0
        return (pos.side === 'LONG' ? 1 : -1) * pos.quantity * (price - pos.avg_entry_price)
      }
      return sim.pnl  // total when no specific pane active
    }
    return sim.pnl
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

  // ── SSE at app level ─────────────────────────────────────────────────────────
  const handleSSEMessage = useCallback((event: Record<string, unknown>) => {
    if (event.type === 'tick') {
      sim.setLatestTick(event as unknown as Parameters<typeof sim.setLatestTick>[0])
    } else if (event.type === 'session_ended') {
      sim.handleSessionEnded()
    } else if (event.type === 'order_filled') {
      sim.handleOrderFilled(event.order_id as string)
    }
  }, [sim.setLatestTick, sim.handleSessionEnded, sim.handleOrderFilled])

  useSSE(sim.sseUrl, handleSSEMessage)

  const handleStart = useCallback(async (startTime: string, speed: number, instrumentConfig: InstrumentConfig) => {
    await sim.startSession(startTime, speed, instrumentConfig)
  }, [sim.startSession])

  // ── Buy/Sell wired to active right ────────────────────────────────────────────
  const handleBuy = useCallback(async () => {
    await sim.buy(tradingActiveRight)
  }, [sim.buy, tradingActiveRight])

  const handleSell = useCallback(async () => {
    await sim.sell(tradingActiveRight)
  }, [sim.sell, tradingActiveRight])

  // ── Layout rendering helpers ──────────────────────────────────────────────────
  const rowHeight = Math.max(160, Math.floor((columnHeight - 52) / 2))

  const renderPane = (pane: PaneConfig, height: number, style?: React.CSSProperties) => (
    <div key={pane.id} style={{ position: 'relative', minHeight: height, minWidth: 0, ...style }}>
      {panes.length > 1 && (
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
        height={height}
        paneType={pane.type}
        strike={pane.strike}
        expiry={pane.expiry}
        right={pane.right as 'CE' | 'PE' | undefined}
        isActive={pane.id === activePaneId}
        onActivate={() => setActivePaneId(pane.id)}
      />
    </div>
  )

  const renderLayout = () => {
    const gap = 12
    if (layoutPreset === 1) {
      const h = columnHeight - 52
      return panes[0] ? renderPane(panes[0], Math.max(160, h)) : null
    }
    if (layoutPreset === 2) {
      const h = Math.max(160, Math.floor((columnHeight - 52 - gap) / 2))
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap }}>
          {panes.slice(0, 2).map(p => renderPane(p, h))}
        </div>
      )
    }
    if (layoutPreset === 3) {
      // Row 1: full-width top pane; Row 2: two half-width panes
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '10px 20px', background: '#161b22', borderBottom: '1px solid #30363d',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: '#58a6ff' }}>TradeMatangi</span>
        <span style={{ fontSize: 12, color: '#484f58' }}>Phase III — Beta</span>
        <div style={{ flex: 1 }} />
        <WalletWidget date={sim.date} refreshKey={sim.walletRefreshKey} />
        <SettingsModal
          date={sim.date}
          onWalletReset={sim.incrementWalletRefreshKey}
          onFundsRatioChange={(mode, ratios) => { setFundsRatioMode(mode); setFundsRatios(ratios) }}
        />
      </div>

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

      {/* Session Controls */}
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
      />

      {/* Layout control bar */}
      <div style={{
        padding: '6px 12px', background: '#0d1117', borderBottom: '1px solid #30363d',
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <label style={{ fontSize: 12, color: '#484f58', display: 'flex', alignItems: 'center', gap: 6 }}>
          Layout:
          <select
            value={layoutPreset}
            onChange={e => handleLayoutChange(Number(e.target.value) as LayoutPreset)}
            style={{
              background: '#161b22', border: '1px solid #30363d', color: '#e6edf3',
              borderRadius: 6, padding: '3px 8px', fontSize: 12,
            }}
          >
            <option value={1}>1 Pane</option>
            <option value={2}>2 Panes</option>
            <option value={3}>3 Panes</option>
            <option value={4}>4 Panes</option>
          </select>
        </label>

        <div style={{ width: 1, height: 16, background: '#30363d', margin: '0 4px' }} />

        <span style={{ fontSize: 12, color: '#484f58' }}>Add pane:</span>

        {instrumentType === 'options' && (
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

        {instrumentType === 'equity' && (
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
          disabled={instrumentType === 'options' && addPaneType !== 'equity' && !optionsReady}
          style={{
            background: '#21262d', border: '1px solid #30363d', color: '#8b949e',
            borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer',
          }}
        >+ Add</button>

        {instrumentType === 'options' && (
          <span style={{ fontSize: 11, color: '#484f58', marginLeft: 4 }}>
            {activeRight ? `Active: ${activeRight}` : 'Click a CE/PE pane to trade'}
          </span>
        )}
      </div>

      {/* Main content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Chart column */}
        <div
          ref={chartColumnRef}
          style={{ flex: 1, overflow: 'auto', padding: 12 }}
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
            onBuy={handleBuy}
            onSell={handleSell}
            activeRight={instrumentType === 'options' ? activeRight : undefined}
            activeLabel={activeLabel}
          />

          {/* Combined P&L for options (both CE + PE) */}
          {instrumentType === 'options' && sim.sessionState !== 'idle' && sim.sessionState !== 'ended' && (
            <div style={{
              background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
              padding: '10px 16px', fontSize: 12,
            }}>
              <div style={{ color: '#8b949e', marginBottom: 6 }}>Combined P&L</div>
              <span style={{
                fontWeight: 700, fontSize: 15,
                color: sim.pnl > 0 ? '#26a641' : sim.pnl < 0 ? '#f85149' : '#8b949e',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {sim.pnl >= 0 ? '+' : ''}{sim.pnl.toFixed(2)}
              </span>
              {idle || (
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
              onPlaceOrder={(side, orderType, price, quantity, opts) =>
                sim.placeOrder(side, orderType, price, quantity, {
                  ...opts,
                  ...(tradingActiveRight ? { right: tradingActiveRight } : {}),
                })
              }
              onCancelOrder={sim.cancelOrder}
            />
          </div>
          <TradeHistory trades={sim.trades} />
        </div>
      </div>
    </div>
  )
}

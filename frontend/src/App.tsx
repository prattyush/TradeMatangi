import { useCallback, useEffect, useRef, useState } from 'react'
import Chart from './components/Chart'
import SessionControls from './components/SessionControls'
import TradePanel from './components/TradePanel'
import TradeHistory from './components/TradeHistory'
import OrderPanel from './components/OrderPanel'
import WalletWidget from './components/WalletWidget'
import SettingsModal from './components/SettingsModal'
import { useSimulation } from './hooks/useSimulation'
import { useSSE } from './hooks/useSSE'

const FIXED_USER = { userId: 'abc12300-0000-0000-0000-000000000001', username: 'abc123' }

interface PaneConfig {
  id: number
  intervalMinutes: number
}

const INTERVAL_OPTIONS = [1, 3, 5, 15, 30]
let nextPaneId = 3

export default function App() {
  const sim = useSimulation()

  // Seed localStorage user on first load
  useEffect(() => {
    if (!localStorage.getItem('user')) {
      localStorage.setItem('user', JSON.stringify(FIXED_USER))
    }
  }, [])

  const [panes, setPanes] = useState<PaneConfig[]>([
    { id: 1, intervalMinutes: 3 },
    { id: 2, intervalMinutes: 5 },
  ])
  const [addInterval, setAddInterval] = useState(15)
  const chartColumnRef = useRef<HTMLDivElement>(null)
  const [columnHeight, setColumnHeight] = useState(window.innerHeight - 120)

  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      setColumnHeight(entries[0].contentRect.height)
    })
    if (chartColumnRef.current) obs.observe(chartColumnRef.current)
    return () => obs.disconnect()
  }, [])

  // For 1-2 panes: fill container equally. For 3+: fixed 280px (scrolls).
  const paneHeight = panes.length <= 2
    ? Math.max(180, Math.floor((columnHeight - 52 - 12 * (panes.length - 1)) / panes.length))
    : 280

  // ── SSE at app level — dispatches to simulation state ──────────────────────
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

  const handleStart = useCallback(async (startTime: string, speed: number) => {
    await sim.startSession(startTime, speed)
  }, [sim.startSession])

  const addPane = useCallback(() => {
    setPanes(ps => [...ps, { id: nextPaneId++, intervalMinutes: addInterval }])
  }, [addInterval])

  const removePane = useCallback((id: number) => {
    setPanes(ps => ps.filter(p => p.id !== id))
  }, [])

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
        <SettingsModal date={sim.date} onWalletReset={sim.incrementWalletRefreshKey} />
      </div>

      {/* Insufficient funds error banner */}
      {sim.orderError && (
        <div style={{
          background: '#3d1f1f', borderBottom: '1px solid #f85149',
          padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ color: '#f85149', fontSize: 13 }}>{sim.orderError}</span>
          <button
            onClick={sim.clearOrderError}
            style={{
              marginLeft: 'auto', background: 'none', border: 'none',
              color: '#8b949e', cursor: 'pointer', fontSize: 14,
            }}
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
      />

      {/* Main Content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Chart column */}
        <div ref={chartColumnRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto', padding: 12, gap: 12 }}>
          {panes.map((pane, idx) => (
            <div key={pane.id} style={{ position: 'relative' }}>
              {panes.length > 1 && (
                <button
                  onClick={() => removePane(pane.id)}
                  title="Remove pane"
                  style={{
                    position: 'absolute', top: 6, right: 6, zIndex: 10,
                    background: 'none', border: 'none', color: '#484f58',
                    cursor: 'pointer', fontSize: 13, lineHeight: 1,
                  }}
                >✕</button>
              )}
              <Chart
                symbol={sim.symbol}
                tradingDate={sim.date}
                startTime={sim.startTime}
                intervalMinutes={pane.intervalMinutes}
                latestTick={sim.latestTick}
                onPriceUpdate={idx === 0 ? undefined : undefined}  // price shown in TradePanel from sim.currentPrice
                height={paneHeight}
              />
            </div>
          ))}

          {/* Add pane control */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 2 }}>
            <span style={{ fontSize: 12, color: '#8b949e' }}>Add pane:</span>
            <select
              value={addInterval}
              onChange={e => setAddInterval(Number(e.target.value))}
              style={{
                background: '#161b22', border: '1px solid #30363d', color: '#e6edf3',
                borderRadius: 6, padding: '3px 8px', fontSize: 12,
              }}
            >
              {INTERVAL_OPTIONS.map(m => (
                <option key={m} value={m}>{m}m</option>
              ))}
            </select>
            <button
              onClick={addPane}
              style={{
                background: '#21262d', border: '1px solid #30363d', color: '#8b949e',
                borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer',
              }}
            >
              + Add
            </button>
          </div>
        </div>

        {/* Right sidebar */}
        <div style={{
          width: 240, padding: 12, display: 'flex', flexDirection: 'column',
          gap: 12, overflowY: 'auto', borderLeft: '1px solid #30363d',
        }}>
          <TradePanel
            sessionState={sim.sessionState}
            currentPrice={sim.currentPrice}
            position={sim.position}
            pnl={sim.pnl}
            onBuy={sim.buy}
            onSell={sim.sell}
          />
          <div style={{ borderTop: '1px solid #21262d', paddingTop: 12 }}>
            <OrderPanel
              sessionState={sim.sessionState}
              currentPrice={sim.currentPrice}
              openOrders={sim.openOrders}
              onPlaceOrder={sim.placeOrder}
              onCancelOrder={sim.cancelOrder}
            />
          </div>
          <TradeHistory trades={sim.trades} />
        </div>
      </div>
    </div>
  )
}

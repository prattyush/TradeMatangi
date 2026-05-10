import { useCallback } from 'react'
import Chart from './components/Chart'
import SessionControls from './components/SessionControls'
import TradePanel from './components/TradePanel'
import TradeHistory from './components/TradeHistory'
import { useSimulation } from './hooks/useSimulation'

export default function App() {
  const sim = useSimulation()

  const handleStart = useCallback(async (startTime: string, speed: number) => {
    await sim.startSession(startTime, speed)
  }, [sim.startSession])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '10px 20px', background: '#161b22', borderBottom: '1px solid #30363d',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: '#58a6ff' }}>TradeMatangi</span>
        <span style={{ fontSize: 12, color: '#484f58' }}>Phase I — Simulated Replay</span>
      </div>

      {/* Session Controls */}
      <SessionControls
        sessionState={sim.sessionState}
        onStart={handleStart}
        onStop={sim.stopSession}
        onPause={sim.pauseSession}
        onResume={sim.resumeSession}
      />

      {/* Main Content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', gap: 0 }}>
        {/* Chart area */}
        <div style={{ flex: 1, padding: 12, overflow: 'hidden' }}>
          <Chart
            sseUrl={sim.sseUrl}
            onPriceUpdate={sim.updateCurrentPrice}
            onSessionEnded={sim.handleSessionEnded}
            preSessionCandles={sim.preSessionCandles}
          />
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
          <TradeHistory trades={sim.trades} />
        </div>
      </div>
    </div>
  )
}

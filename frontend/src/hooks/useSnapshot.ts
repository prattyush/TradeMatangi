import { useState, useCallback } from 'react'
import api, { SnapshotPayload, SnapshotPosition } from '../services/api'
import { SimulationState } from './useSimulation'

function computeSnapshotPnL(
  side: string,
  quantity: number,
  avgEntryPrice: number,
  currentPrice: number,
): { pnl: number; pnl_pct: number } {
  if (side === 'FLAT' || quantity === 0) return { pnl: 0, pnl_pct: 0 }
  const multiplier = side === 'LONG' ? 1 : -1
  const pnl = multiplier * (currentPrice - avgEntryPrice) * quantity
  const invested = avgEntryPrice * quantity
  const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0
  return { pnl, pnl_pct: Math.round(pnlPct * 100) / 100 }
}

function toPositionSnapshot(pos: import('../services/api').Position, currentPrice: number): SnapshotPosition {
  const { pnl, pnl_pct } = computeSnapshotPnL(pos.side, pos.quantity, pos.avg_entry_price, currentPrice)
  return {
    side: pos.side,
    quantity: pos.quantity,
    avg_entry_price: pos.avg_entry_price,
    pnl,
    pnl_pct,
  }
}

export interface SnapshotEventInput {
  type: string
  description: string
  details: Record<string, unknown>
}

export function useSnapshot(simRef: React.RefObject<SimulationState>) {
  const [snapshotActive, setSnapshotActive] = useState(false)

  const startSnapshots = useCallback(() => setSnapshotActive(true), [])
  const stopSnapshots = useCallback(() => setSnapshotActive(false), [])

  const captureSnapshot = useCallback(
    (event: SnapshotEventInput) => {
      const sim = simRef.current
      if (!sim || !sim.sessionId) return

      const eventId = crypto.randomUUID()
      const userId = (() => {
        try {
          const stored = localStorage.getItem('auth_user')
          if (stored) return JSON.parse(stored).userId || ''
        } catch {}
        return ''
      })()

      const eqPrice = sim.currentPrice || sim.latestEquityTick?.close || 0
      const isOptions = sim.sessionInstrumentType === 'options'
      const cePrice = isOptions ? (sim.currentPriceCE || 0) : 0
      const pePrice = isOptions ? (sim.currentPricePE || 0) : 0

      const barTime =
        sim.latestEquityTick?.time
          ? Math.floor(sim.latestEquityTick.time / 180) * 180
          : 0

      const barOhlc = sim.latestEquityTick
        ? {
            open: sim.latestEquityTick.open,
            high: sim.latestEquityTick.high,
            low: sim.latestEquityTick.low,
            close: sim.latestEquityTick.close,
          }
        : null

      // For options, use CE/PE currentPrice; for equity, use equity price
      const posCePrice = sim.currentPriceCE || 0
      const posPePrice = sim.currentPricePE || 0

      const walletBalance =
        sim.sessionCapital > 0
          ? sim.sessionCapital -
            Math.abs(
              sim.position.side !== 'FLAT'
                ? sim.position.quantity * sim.position.avg_entry_price
                : 0
            )
          : 0

      const invested =
        sim.position.side !== 'FLAT'
          ? sim.position.quantity * sim.position.avg_entry_price
          : 0
      const walletUsedPct =
        sim.sessionCapital > 0
          ? Math.round((invested / sim.sessionCapital) * 10000) / 100
          : 0

      const payload: SnapshotPayload = {
        event_id: eventId,
        session_id: sim.sessionId,
        user_id: userId,
        symbol: sim.symbol,
        date: sim.date,
        instrument_type: sim.sessionInstrumentType,
        session_type: sim.sessionType,
        timestamp: Date.now() / 1000,
        event: {
          type: event.type,
          description: event.description,
          details: event.details,
        },
        snapshot: {
          current_price: eqPrice,
          current_price_ce: cePrice,
          current_price_pe: pePrice,
          bar_time: barTime,
          bar_ohlc: barOhlc,
          position: toPositionSnapshot(sim.position, eqPrice),
          position_ce: toPositionSnapshot(sim.positionCE, posCePrice),
          position_pe: toPositionSnapshot(sim.positionPE, posPePrice),
          wallet_balance: walletBalance,
          session_capital: sim.sessionCapital,
          wallet_used_pct: walletUsedPct,
          open_orders: (sim.openOrders || []).filter(o => o.status === 'PENDING'),
          strike_ce: sim.sessionStrikeCE,
          strike_pe: sim.sessionStrikePE,
          expiry: sim.sessionExpiry,
        },
      }

      api.saveSnapshot(payload).catch(() => {})
    },
    [simRef],
  )

  return { snapshotActive, startSnapshots, stopSnapshots, captureSnapshot }
}

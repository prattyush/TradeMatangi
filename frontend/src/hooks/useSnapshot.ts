import { useState, useCallback, useRef, useEffect } from 'react'
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
  const snapshotActiveRef = useRef(snapshotActive)
  useEffect(() => { snapshotActiveRef.current = snapshotActive }, [snapshotActive])

  const startSnapshots = useCallback(() => setSnapshotActive(true), [])
  const stopSnapshots = useCallback(() => setSnapshotActive(false), [])

  const captureSnapshot = useCallback(
    (event: SnapshotEventInput) => {
      if (!snapshotActiveRef.current) return
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

      const eqPos = toPositionSnapshot(sim.position, eqPrice)
      const cePos = isOptions ? toPositionSnapshot(sim.positionCE, posCePrice) : null
      const pePos = isOptions ? toPositionSnapshot(sim.positionPE, posPePrice) : null

      // Combined P&L across all positions
      const combinedPnl = eqPos.pnl + (cePos?.pnl ?? 0) + (pePos?.pnl ?? 0)
      const totalInvested =
        (sim.position.side !== 'FLAT' ? sim.position.quantity * sim.position.avg_entry_price : 0) +
        (isOptions && sim.positionCE.side !== 'FLAT' ? sim.positionCE.quantity * sim.positionCE.avg_entry_price : 0) +
        (isOptions && sim.positionPE.side !== 'FLAT' ? sim.positionPE.quantity * sim.positionPE.avg_entry_price : 0)
      const combinedPnlPct = totalInvested > 0 ? Math.round((combinedPnl / totalInvested) * 10000) / 100 : 0

      const walletBalance = sim.sessionCapital + combinedPnl
      const walletUsedPct = sim.sessionCapital > 0
        ? Math.round((totalInvested / sim.sessionCapital) * 10000) / 100
        : 0

      const activePositions = [
        sim.position.side !== 'FLAT' ? 1 : 0,
        isOptions && sim.positionCE.side !== 'FLAT' ? 1 : 0,
        isOptions && sim.positionPE.side !== 'FLAT' ? 1 : 0,
      ].reduce((a: number, b: number) => a + b, 0)

      // Determine quantity mode from the event details (passed by OrderPanel)
      const qtyMode = (event.details.fundsRatioPct != null && event.details.fundsRatioPct !== undefined)
        ? 'funds_ratio' : 'quantity'

      // Enrich event details with session state for better UI display
      const enrichedEvent = {
        type: event.type,
        description: event.description,
        details: {
          ...event.details,
          // Order context: what the user was doing
          _orderSide: event.details.side,
          _orderType: event.details.orderType,
          _orderPrice: event.details.price,
          _orderQty: event.details.quantity,
          _fundsRatioPct: event.details.fundsRatioPct,
          // Session context
          _sessionCapital: sim.sessionCapital,
          _walletBalance: Math.round(walletBalance * 100) / 100,
          _combinedPnl: Math.round(combinedPnl * 100) / 100,
          _combinedPnlPct: combinedPnlPct,
          _activePositions: activePositions,
          _openOrderCount: (sim.openOrders || []).filter(o => o.status === 'PENDING').length,
          _positionEquity: `${sim.position.side} ${sim.position.quantity}`,
          _isOptions: isOptions,
        },
      }

      const payload: SnapshotPayload = {
        event_id: eventId,
        session_id: sim.sessionId,
        user_id: userId,
        symbol: sim.symbol,
        date: sim.date,
        instrument_type: sim.sessionInstrumentType,
        session_type: sim.sessionType,
        timestamp: Date.now() / 1000,
        event: enrichedEvent,
        snapshot: {
          current_price: eqPrice,
          current_price_ce: cePrice,
          current_price_pe: pePrice,
          bar_time: barTime,
          bar_ohlc: barOhlc,
          position: eqPos,
          position_ce: cePos ?? { side: 'FLAT', quantity: 0, avg_entry_price: 0, pnl: 0, pnl_pct: 0 },
          position_pe: pePos ?? { side: 'FLAT', quantity: 0, avg_entry_price: 0, pnl: 0, pnl_pct: 0 },
          combined_pnl: Math.round(combinedPnl * 100) / 100,
          combined_pnl_pct: combinedPnlPct,
          wallet_balance: Math.round(walletBalance * 100) / 100,
          session_capital: sim.sessionCapital,
          wallet_used_pct: walletUsedPct,
          active_positions: activePositions,
          open_orders: (sim.openOrders || []).filter(o => o.status === 'PENDING'),
          strike_ce: sim.sessionStrikeCE,
          strike_pe: sim.sessionStrikePE,
          expiry: sim.sessionExpiry,
          event_timestamp: Math.floor(Date.now() / 1000),
          quantity_mode: qtyMode,
        },
      }

      api.saveSnapshot(payload).catch((err) => {
        console.warn('Snapshot save failed:', err)
      })
    },
    [simRef],
  )

  return { snapshotActive, startSnapshots, stopSnapshots, captureSnapshot }
}

/**
 * Tests for the in-session trade labeling slice of useSimulation.
 *
 * Focus: `onTradesChanged` correctly detects per-leg net-qty transitions,
 * assigns monotonic round_trip_index per leg, and moves entries from
 * `currentOpenEntries` to `pendingExitLabels`.
 *
 * NOTE: Requires vitest + @testing-library/react-hooks. Not currently
 * installed in this project's frontend. Files are committed so the tests
 * can be wired up later.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react-hooks'

// Stub the api module — onTradesChanged doesn't hit the network but the
// hook imports it at module load.
vi.mock('../../services/api', () => ({
  default: {
    startSimulation: vi.fn(),
    stopSimulation: vi.fn(),
    pauseSimulation: vi.fn(),
    resumeSimulation: vi.fn(),
    getPosition: vi.fn(),
    getTrades: vi.fn().mockResolvedValue([]),
    placeOrder: vi.fn(),
    buy: vi.fn(),
    sell: vi.fn(),
  },
}))

import { useSimulation } from '../useSimulation'

const trade = (overrides: Partial<{
  trade_id: string
  session_id: string
  side: 'BUY' | 'SELL'
  quantity: number
  price: number
  timestamp: number
  right?: string
  symbol: string
  commission: number
}>) => ({
  trade_id: overrides.trade_id ?? 't1',
  session_id: overrides.session_id ?? 'sess-1',
  side: overrides.side ?? 'BUY',
  quantity: overrides.quantity ?? 50,
  price: overrides.price ?? 100,
  timestamp: overrides.timestamp ?? 1,
  symbol: overrides.symbol ?? 'NIFTY',
  right: overrides.right,
  commission: 0,
})

describe('useSimulation — in-session labeling', () => {
  beforeEach(() => {
    // Reset module-level state across tests if needed
  })

  it('detects a single equity open → close as one pending exit RT', async () => {
    const { result } = renderHook(() => useSimulation())

    // Start a session
    await act(async () => {
      await result.current.startSession('09:15', 1, { instrument_type: 'equity' })
    })

    // Buy 50 equity
    await act(async () => {
      result.current.addTradeFromSSE(trade({ trade_id: 't1', side: 'BUY', quantity: 50 }))
    })
    result.current.onTradesChanged()

    // Sell 50 equity — closes the leg
    await act(async () => {
      result.current.addTradeFromSSE(trade({ trade_id: 't2', side: 'SELL', quantity: 50, price: 110 }))
    })
    result.current.onTradesChanged()

    expect(result.current.pendingExitLabels).toHaveLength(1)
    expect(result.current.pendingExitLabels[0]).toMatchObject({
      right: null,
      round_trip_index: 0,
    })
    expect(result.current.pendingExitLabels[0].pnl).toBeCloseTo(500, 0)
  })

  it('assigns monotonically increasing rt_index across multiple equity RTs', async () => {
    const { result } = renderHook(() => useSimulation())
    await act(async () => {
      await result.current.startSession('09:15', 1, { instrument_type: 'equity' })
    })

    // RT1: BUY 50 → SELL 50
    act(() => { result.current.addTradeFromSSE(trade({ trade_id: 't1', side: 'BUY', quantity: 50 })) })
    result.current.onTradesChanged()
    act(() => { result.current.addTradeFromSSE(trade({ trade_id: 't2', side: 'SELL', quantity: 50, price: 105 })) })
    result.current.onTradesChanged()

    // RT2: BUY 30 → SELL 30
    act(() => { result.current.addTradeFromSSE(trade({ trade_id: 't3', side: 'BUY', quantity: 30 })) })
    result.current.onTradesChanged()
    act(() => { result.current.addTradeFromSSE(trade({ trade_id: 't4', side: 'SELL', quantity: 30, price: 95 })) })
    result.current.onTradesChanged()

    expect(result.current.pendingExitLabels).toHaveLength(2)
    expect(result.current.pendingExitLabels.map((r: { round_trip_index: number }) => r.round_trip_index)).toEqual([0, 1])
  })

  it('handles simultaneous CE open / PE close in same batch', async () => {
    const { result } = renderHook(() => useSimulation())
    await act(async () => {
      await result.current.startSession('09:15', 1, { instrument_type: 'options' })
    })

    // CE opened earlier (still open)
    act(() => { result.current.addTradeFromSSE(trade({ trade_id: 'ce1', side: 'BUY', quantity: 50, right: 'CE' })) })
    result.current.onTradesChanged()

    // PE was opened AND closed in this batch
    act(() => {
      result.current.addTradeFromSSE(trade({ trade_id: 'pe1', side: 'BUY', quantity: 50, right: 'PE' }))
      result.current.addTradeFromSSE(trade({ trade_id: 'pe2', side: 'SELL', quantity: 50, right: 'PE', price: 95 }))
    })
    result.current.onTradesChanged()

    // CE should still be in currentOpenEntries, PE should be in pendingExitLabels
    expect(result.current.currentOpenEntries.some((o: { right: string | null }) => o.right === 'CE')).toBe(true)
    expect(result.current.pendingExitLabels.some((p: { right: string | null }) => p.right === 'PE')).toBe(true)
  })

  it('drops pending RT when recordSavedExit is called', async () => {
    const { result } = renderHook(() => useSimulation())
    await act(async () => {
      await result.current.startSession('09:15', 1, { instrument_type: 'equity' })
    })
    act(() => { result.current.addTradeFromSSE(trade({ trade_id: 't1', side: 'BUY', quantity: 50 })) })
    result.current.onTradesChanged()
    act(() => { result.current.addTradeFromSSE(trade({ trade_id: 't2', side: 'SELL', quantity: 50 })) })
    result.current.onTradesChanged()
    expect(result.current.pendingExitLabels).toHaveLength(1)

    act(() => { result.current.recordSavedExit('sess-1', 0, null) })
    expect(result.current.pendingExitLabels).toHaveLength(0)
  })

  it('resetLabelTracking clears all state on new session', async () => {
    const { result } = renderHook(() => useSimulation())
    await act(async () => {
      await result.current.startSession('09:15', 1, { instrument_type: 'equity' })
    })
    act(() => {
      result.current.addTradeFromSSE(trade({ trade_id: 't1', side: 'BUY', quantity: 50 }))
    })
    result.current.onTradesChanged()
    act(() => {
      result.current.addTradeFromSSE(trade({ trade_id: 't2', side: 'SELL', quantity: 50 }))
    })
    result.current.onTradesChanged()
    expect(result.current.pendingExitLabels.length).toBeGreaterThan(0)

    act(() => { result.current.resetLabelTracking() })
    expect(result.current.pendingExitLabels).toHaveLength(0)
    expect(result.current.currentOpenEntries).toHaveLength(0)
    expect(result.current.savedEntryRtKeys).toHaveLength(0)
  })

  it('does not produce pending RT when leg was already flat (no opening event)', () => {
    const { result } = renderHook(() => useSimulation())
    // No session start, no trades
    act(() => { result.current.onTradesChanged() })
    expect(result.current.pendingExitLabels).toHaveLength(0)
  })
})
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AnalysisTrade } from '../api'
import { roundTripMarkerText, tradesForRoundTrip, type LabeledRoundTrip } from './model'

/**
 * What the chart beside a one-round-trip-at-a-time screen needs, for the round trip being viewed: the marker text (numbers,
 * and BUY/SELL on the underlying), the time to centre on, and the executions to draw (only this trade's unless all markers
 * are asked for). Shared by Label Trades, Trade Walkthrough and What If.
 */
export function useRoundTripView(roundTrips: LabeledRoundTrip[], current: LabeledRoundTrip | undefined, allTrades: AnalysisTrade[], showAllMarkers: boolean) {
  const getMarkerText = useCallback((trade: AnalysisTrade, forOption?: boolean) => roundTripMarkerText(roundTrips, trade, !forOption), [roundTrips])
  // Centre the charts on the viewed trade's entry.
  const focusTime = current?.entry_trades[0]?.timestamp ?? current?.exit_trades[0]?.timestamp
  // The chart shows only the viewed trade's executions (unless "All markers" is on).
  const chartTrades = useMemo(() => {
    if (!current || showAllMarkers) return allTrades
    const own = tradesForRoundTrip(current, allTrades)
    return own.length ? own : allTrades
  }, [current, showAllMarkers, allTrades])
  return { getMarkerText, focusTime, chartTrades }
}

/** The maximize toggle of the split layout; Escape restores. */
export function useMaximized(): [boolean, (value: boolean) => void] {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!maximized) return
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') setMaximized(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [maximized])
  return [maximized, setMaximized]
}

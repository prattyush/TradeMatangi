import { createContext, useCallback, useContext, useMemo } from 'react'
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

/**
 * Whether the Analysis day card is maximized. The card (`GroupCard`) owns the one Maximize button for all four tabs and
 * provides this; a tab opened on its own (the phone's full-screen overlays) has no card, so it is never maximized.
 */
export const CardMaximizeContext = createContext<boolean | null>(null)

/** The card's maximized state for a tab: true stacks the Underlying and strike charts. `inCard` tells the layout the card already supplies the full-window container. */
export function useCardMaximized(): { maximized: boolean; inCard: boolean } {
  const value = useContext(CardMaximizeContext)
  return { maximized: value === true, inCard: value !== null }
}

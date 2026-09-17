import type { Candle, ChartEvent, ChartSnapshot } from './contracts'

export interface ChartState { candles: Candle[]; generation: number; eventId: number }

export function fromSnapshot(snapshot: ChartSnapshot): ChartState {
  return { candles: [...snapshot.candles].sort((a, b) => a.timestamp - b.timestamp), generation: snapshot.generation, eventId: snapshot.eventId }
}

/** Applies only newer incremental events; a current bar replaces, never duplicates, its timestamp. */
export function applyEvent(state: ChartState, event: ChartEvent): ChartState {
  if (event.generation < state.generation || (event.generation === state.generation && event.eventId <= state.eventId)) return state
  if (event.type !== 'candle') return { ...state, generation: event.generation, eventId: event.eventId }
  const last = state.candles[state.candles.length - 1]
  if (last && event.candle.timestamp < last.timestamp) return { ...state, generation: event.generation, eventId: event.eventId }
  const candles = last?.timestamp === event.candle.timestamp
    ? [...state.candles.slice(0, -1), event.candle]
    : [...state.candles, event.candle]
  return { candles, generation: event.generation, eventId: event.eventId }
}

/**
 * Keep Browse context through the replay cursor, then replace the current
 * in-progress candle with the backend-authoritative snapshot.
 */
export function replayCandles(candles: Candle[], cursor: number | undefined, current?: Candle, intervalSeconds = 60): Candle[] {
  if (!cursor) return candles
  const cutoff = current?.timestamp ?? cursor
  const completed = candles.filter(candle => candle.timestamp < cutoff && candle.timestamp + intervalSeconds <= cursor)
  return [...completed, ...(current ? [current] : [])]
}

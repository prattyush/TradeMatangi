/**
 * VWAP and volume-histogram helpers for the Lightweight charts (KLine uses the library's own VWAP).
 *
 * VWAP = running sum(typical price x volume) / sum(volume), with typical price = (high + low + close) / 3, restarted every
 * trading day. Candle times are IST wall-clock labelled as UTC (see the IST timestamps rule), so `floor(time / 86400)` is
 * the IST trading date. While a day's cumulative volume is still 0 the line shows the typical price, like the KLine library,
 * rather than a misleading 0.
 */
export interface VolumeCandle {
  time: number
  open?: number
  high: number
  low: number
  close: number
  volume?: number | null
}

export interface VwapState {
  day: number
  cumVolume: number
  cumPriceVolume: number
}

export interface VwapPoint {
  time: number
  value: number
}

export interface HistogramPoint {
  time: number
  value: number
  color: string
}

export const VWAP_DAY_SECONDS = 86400
export const VOLUME_UP_COLOR = 'rgba(38, 166, 154, 0.5)'
export const VOLUME_DOWN_COLOR = 'rgba(239, 83, 80, 0.5)'
export const VWAP_COLOR = '#d2a8ff'

/** True when at least one candle reports volume. Indices report none (null or absent), so VOL and VWAP are hidden for them. */
export const candlesHaveVolume = (candles: ReadonlyArray<{ volume?: number | null }>) =>
  candles.some(candle => candle.volume !== undefined && candle.volume !== null)

/** The state after one more bar. `state` is not modified, so a forming bar can be re-applied to the same base on every tick. */
export function nextVwap(state: VwapState | null, candle: VolumeCandle): { state: VwapState; value: number } {
  const day = Math.floor(candle.time / VWAP_DAY_SECONDS)
  const base = state && state.day === day ? state : { day, cumVolume: 0, cumPriceVolume: 0 }
  const price = (candle.high + candle.low + candle.close) / 3
  const volume = candle.volume ?? 0
  const next = { day, cumVolume: base.cumVolume + volume, cumPriceVolume: base.cumPriceVolume + price * volume }
  return { state: next, value: next.cumVolume === 0 ? price : next.cumPriceVolume / next.cumVolume }
}

/** One VWAP point per candle, and the state after the last one (the base for the next bar). */
export function computeVwap(candles: ReadonlyArray<VolumeCandle>): { points: VwapPoint[]; state: VwapState | null } {
  let state: VwapState | null = null
  const points: VwapPoint[] = []
  for (const candle of candles) {
    const step = nextVwap(state, candle)
    state = step.state
    points.push({ time: candle.time, value: step.value })
  }
  return { points, state }
}

/** The state after every candle in `candles` except the last, i.e. the base for a still-forming last bar. */
export function vwapBeforeLast(candles: ReadonlyArray<VolumeCandle>): VwapState | null {
  return computeVwap(candles.slice(0, -1)).state
}

export function volumePoint(candle: VolumeCandle, upColor = VOLUME_UP_COLOR, downColor = VOLUME_DOWN_COLOR): HistogramPoint {
  const rising = candle.open === undefined || candle.close >= candle.open
  return { time: candle.time, value: candle.volume ?? 0, color: rising ? upColor : downColor }
}

export const volumeHistogram = (candles: ReadonlyArray<VolumeCandle>): HistogramPoint[] => candles.map(candle => volumePoint(candle))

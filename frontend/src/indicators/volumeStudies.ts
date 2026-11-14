import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import {
  VWAP_COLOR, candlesHaveVolume, computeVwap, nextVwap, volumeHistogram, volumePoint,
  type VolumeCandle, type VwapState,
} from './vwap'

/**
 * A volume histogram (overlay, bottom fifth of the pane) and a VWAP line for one Lightweight chart.
 * Both series are created hidden-capable and stay empty for an instrument that reports no volume (an index).
 * Call `setData` with the full history, then `update` with the forming bar on every tick: `update` re-applies the
 * forming bar to the state before it, so ticks inside one bar never accumulate twice.
 */
export interface VolumeStudies {
  setData(candles: ReadonlyArray<VolumeCandle>): void
  update(candle: VolumeCandle): void
  setVisible(options: { vwap: boolean; volume: boolean }): void
  /** True once the data has volume; the menu hides the two indicators until then. */
  available(): boolean
}

export function attachVolumeStudies(
  chart: IChartApi,
  options: { vwap?: boolean; volume?: boolean; onAvailableChange?: (available: boolean) => void } = {},
): VolumeStudies {
  const histogram: ISeriesApi<'Histogram'> = chart.addHistogramSeries({
    priceScaleId: 'volume',
    priceFormat: { type: 'volume' },
    priceLineVisible: false,
    lastValueVisible: false,
    visible: options.volume ?? false,
  })
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
  const vwap: ISeriesApi<'Line'> = chart.addLineSeries({
    color: VWAP_COLOR,
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    visible: options.vwap ?? false,
  })
  let isAvailable = false
  let lastTime: number | null = null
  let before: VwapState | null = null // state before the bar at lastTime (the forming bar's base)
  let after: VwapState | null = null // state after the bar at lastTime
  const setAvailable = (value: boolean) => {
    if (value === isAvailable) return
    isAvailable = value
    options.onAvailableChange?.(value)
  }
  return {
    setData(candles) {
      if (candles.length === 0) {
        histogram.setData([])
        vwap.setData([])
        lastTime = null
        before = after = null
        return
      }
      if (!candlesHaveVolume(candles)) {
        histogram.setData([])
        vwap.setData([])
        lastTime = null
        before = after = null
        setAvailable(false)
        return
      }
      const { points, state } = computeVwap(candles)
      histogram.setData(volumeHistogram(candles).map(point => ({ ...point, time: point.time as Time })))
      vwap.setData(points.map(point => ({ time: point.time as Time, value: point.value })))
      lastTime = candles[candles.length - 1].time
      after = state
      before = computeVwap(candles.slice(0, -1)).state
      setAvailable(true)
    },
    update(candle) {
      if (!isAvailable && candle.volume != null) setAvailable(true)
      if (!isAvailable) return
      if (lastTime !== null && candle.time < lastTime) return
      if (lastTime === null || candle.time > lastTime) {
        before = after
        lastTime = candle.time
      }
      const step = nextVwap(before, candle)
      after = step.state
      histogram.update({ ...volumePoint(candle), time: candle.time as Time })
      vwap.update({ time: candle.time as Time, value: step.value })
    },
    setVisible({ vwap: showVwap, volume: showVolume }) {
      vwap.applyOptions({ visible: showVwap })
      histogram.applyOptions({ visible: showVolume })
    },
    available: () => isAvailable,
  }
}

/** Candles from a chart's series data (time may be a number or a Lightweight `Time`) plus the volume carried alongside. */
export const toVolumeCandles = (
  rows: ReadonlyArray<{ time: unknown; open: number; high: number; low: number; close: number; volume?: number | null }>,
): VolumeCandle[] =>
  rows.map(row => ({ time: Number(row.time), open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume }))

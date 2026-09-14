export interface IndicatorCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export type RocComparisonKey = 'underlying_ce' | 'underlying_pe' | 'ce_pe' | 'ce_ul_pe_ul'
export type RocRatioMode = 'normalized' | 'raw'

export interface RocPoint {
  time: number
  value: number
}

export interface RocSeries {
  key: string
  label: string
  color: string
  points: RocPoint[]
}

export const ROC_COMPARISON_META: Record<RocComparisonKey, { label: string; color: string }> = {
  underlying_ce: { label: 'CE / UL', color: '#3fb950' },
  underlying_pe: { label: 'PE / UL', color: '#bc8cff' },
  ce_pe: { label: 'CE / PE', color: '#f0883e' },
  ce_ul_pe_ul: { label: '(CE/UL)/(PE/UL)', color: '#f778ba' },
}

// A normalized move is already scaled to a maximum absolute value of 100.
// Suppressing values below 5 made CE/UL and PE/UL disappear whenever the
// underlying moved in small increments, which is common during live bars.
// Only a true zero denominator is undefined for the ratio.
const MIN_NORMALIZED_MOVE = 1e-9
const MIN_RAW_MOVE = 1e-9

function byTime(candles: IndicatorCandle[]): Map<number, IndicatorCandle> {
  return new Map(candles.map(c => [c.time, c]))
}

function commonTimes(a: IndicatorCandle[], b: IndicatorCandle[]): number[] {
  const bTimes = byTime(b)
  return a.map(c => c.time).filter(time => bTimes.has(time)).sort((x, y) => x - y)
}

function alignToTimes(candles: IndicatorCandle[], times: number[]): IndicatorCandle[] {
  const sorted = [...candles].sort((a, b) => a.time - b.time)
  let index = 0
  let latest: IndicatorCandle | null = null
  return times.flatMap(time => {
    while (index < sorted.length && sorted[index].time <= time) latest = sorted[index++]
    return latest ? [{ ...latest, time }] : []
  })
}

function isSmallBody(candle: IndicatorCandle): boolean {
  const range = candle.high - candle.low
  const body = Math.abs(candle.close - candle.open)
  return range <= 0 || body < range * 0.33
}

function validRatioTimes(...candles: IndicatorCandle[][]): Set<number> {
  const invalid = new Set(
    candles.flatMap(series => series.filter(isSmallBody).map(candle => candle.time)),
  )
  const times = candles.flatMap(series => series.map(candle => candle.time))
  return new Set(times.filter(time => !invalid.has(time)))
}

function normalizedMoveSeries(
  key: string,
  label: string,
  color: string,
  candles: IndicatorCandle[],
  times: number[],
): RocSeries {
  const candleMap = byTime(candles)
  const raw = intervalMovePoints(candleMap, times)
  if (raw.length === 0) return { key, label, color, points: [] }
  const maxAbs = Math.max(...raw.map(point => Math.abs(point.value)), 0)
  const scale = maxAbs > 0 ? maxAbs : 1

  return {
    key,
    label,
    color,
    points: raw.map(point => ({ time: point.time, value: (point.value / scale) * 100 })),
  }
}

function rawMoveSeries(
  key: string,
  label: string,
  color: string,
  candles: IndicatorCandle[],
  times: number[],
): RocSeries {
  const candleMap = byTime(candles)
  return { key, label, color, points: intervalMovePoints(candleMap, times) }
}

// Each interval compares its close with the previous 9-EMA. The EMA is seeded
// with the SMA of the first nine closes, matching the chart EMA convention.
function intervalMovePoints(candleMap: Map<number, IndicatorCandle>, times: number[]): RocPoint[] {
  const period = 9
  const k = 2 / (period + 1)
  const closes = times.map(time => candleMap.get(time)?.close ?? null)
  const emas: (number | null)[] = []
  let sum = 0
  let ema: number | null = null

  for (let index = 0; index < closes.length; index += 1) {
    const close = closes[index]
    if (close == null) {
      emas.push(null)
      continue
    }
    sum += close
    if (index < period - 1) {
      emas.push(null)
    } else if (index === period - 1) {
      ema = sum / period
      emas.push(ema)
    } else {
      ema = close * k + ema! * (1 - k)
      emas.push(ema)
    }
  }

  const points: RocPoint[] = []
  for (let index = 1; index < times.length; index += 1) {
    const current = candleMap.get(times[index])
    const previousEma = emas[index - 1]
    if (!current || previousEma == null || previousEma === 0) continue
    points.push({
      time: current.time,
      value: ((current.close - previousEma) / previousEma) * 100,
    })
  }
  return points
}

function ratioSeries(
  key: string,
  label: string,
  color: string,
  numerator: RocSeries,
  denominator: RocSeries,
  minDenominator: number,
  validTimes: Set<number> | null = null,
): RocSeries {
  const denomByTime = new Map(denominator.points.map(point => [point.time, point.value]))
  let previousValue: number | null = null
  const points = numerator.points
    .map(point => {
      if (validTimes && !validTimes.has(point.time)) {
        if (previousValue == null) return null
        return { time: point.time, value: previousValue }
      }
      const denom = denomByTime.get(point.time)
      if (denom == null || Math.abs(denom) < minDenominator) return null
      const value = Math.abs(point.value / denom)
      previousValue = value
      return { time: point.time, value }
    })
    .filter((point): point is RocPoint => point !== null)
  return { key, label, color, points }
}

export function computeOptionsRocComparison(
  key: RocComparisonKey,
  underlying: IndicatorCandle[],
  ce: IndicatorCandle[] | null,
  pe: IndicatorCandle[] | null,
  mode: RocRatioMode,
  anchor: IndicatorCandle[] | null = null,
): RocSeries[] {
  const moveSeries = mode === 'normalized' ? normalizedMoveSeries : rawMoveSeries
  const minDenominator = mode === 'normalized' ? MIN_NORMALIZED_MOVE : MIN_RAW_MOVE

  if (key === 'underlying_ce' && ce) {
    const times = anchor ? anchor.map(c => c.time) : commonTimes(underlying, ce)
    const alignedUl = alignToTimes(underlying, times)
    const alignedCe = alignToTimes(ce, times)
    const ul = moveSeries('underlying', 'Underlying', '#79c0ff', alignedUl, times)
    const call = moveSeries('ce', 'CE', '#3fb950', alignedCe, times)
    return [ratioSeries('ce_underlying_ratio', 'CE / UL', '#3fb950', call, ul, minDenominator, validRatioTimes(alignedUl, alignedCe))]
  }
  if (key === 'underlying_pe' && pe) {
    const times = anchor ? anchor.map(c => c.time) : commonTimes(underlying, pe)
    const alignedUl = alignToTimes(underlying, times)
    const alignedPe = alignToTimes(pe, times)
    const ul = moveSeries('underlying', 'Underlying', '#79c0ff', alignedUl, times)
    const put = moveSeries('pe', 'PE', '#bc8cff', alignedPe, times)
    return [ratioSeries('pe_underlying_ratio', 'PE / UL', '#bc8cff', put, ul, minDenominator, validRatioTimes(alignedUl, alignedPe))]
  }
  if (key === 'ce_pe' && ce && pe) {
    const times = anchor ? anchor.map(c => c.time) : commonTimes(ce, pe)
    const alignedCe = alignToTimes(ce, times)
    const alignedPe = alignToTimes(pe, times)
    const call = moveSeries('ce', 'CE', '#3fb950', alignedCe, times)
    const put = moveSeries('pe', 'PE', '#bc8cff', alignedPe, times)
    return [ratioSeries('ce_pe_ratio', 'CE / PE', '#f0883e', call, put, minDenominator, validRatioTimes(alignedCe, alignedPe))]
  }
  if (key === 'ce_ul_pe_ul' && ce && pe) {
    const sharedUnderlyingCeTimes = commonTimes(underlying, ce)
    const peTimes = byTime(pe)
    const times = anchor
      ? anchor.map(c => c.time)
      : sharedUnderlyingCeTimes.filter(time => peTimes.has(time)).sort((a, b) => a - b)
    const alignedUl = alignToTimes(underlying, times)
    const alignedCe = alignToTimes(ce, times)
    const alignedPe = alignToTimes(pe, times)
    const ul = moveSeries('underlying', 'Underlying', '#79c0ff', alignedUl, times)
    const call = moveSeries('ce', 'CE', '#3fb950', alignedCe, times)
    const put = moveSeries('pe', 'PE', '#bc8cff', alignedPe, times)
    const ceUl = ratioSeries('ce_underlying_ratio_inner', 'CE / UL', '#3fb950', call, ul, minDenominator)
    const peUl = ratioSeries('pe_underlying_ratio_inner', 'PE / UL', '#bc8cff', put, ul, minDenominator)
    return [ratioSeries('ce_ul_pe_ul_ratio', '(CE/UL)/(PE/UL)', '#f778ba', ceUl, peUl, minDenominator, validRatioTimes(alignedUl, alignedCe, alignedPe))]
  }
  return []
}

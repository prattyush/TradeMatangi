export interface IndicatorCandle {
  time: number
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
    return latest ? [{ time, close: latest.close }] : []
  })
}

function normalizedMoveSeries(
  key: string,
  label: string,
  color: string,
  candles: IndicatorCandle[],
  times: number[],
): RocSeries {
  const candleMap = byTime(candles)
  const first = times.map(time => candleMap.get(time)).find(Boolean)
  if (!first || first.close === 0) return { key, label, color, points: [] }

  const raw = times
    .map(time => {
      const candle = candleMap.get(time)
      if (!candle) return null
      return { time, value: ((candle.close - first.close) / first.close) * 100 }
    })
    .filter((point): point is RocPoint => point !== null)
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
  const first = times.map(time => candleMap.get(time)).find(Boolean)
  if (!first || first.close === 0) return { key, label, color, points: [] }

  const points = times
    .map(time => {
      const candle = candleMap.get(time)
      if (!candle) return null
      return { time, value: ((candle.close - first.close) / first.close) * 100 }
    })
    .filter((point): point is RocPoint => point !== null)

  return { key, label, color, points }
}

function ratioSeries(
  key: string,
  label: string,
  color: string,
  numerator: RocSeries,
  denominator: RocSeries,
  minDenominator: number,
): RocSeries {
  const denomByTime = new Map(denominator.points.map(point => [point.time, point.value]))
  const points = numerator.points
    .map(point => {
      const denom = denomByTime.get(point.time)
      if (denom == null || Math.abs(denom) < minDenominator) return null
      return { time: point.time, value: Math.abs(point.value / denom) }
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
    const ul = moveSeries('underlying', 'Underlying', '#79c0ff', alignToTimes(underlying, times), times)
    const call = moveSeries('ce', 'CE', '#3fb950', alignToTimes(ce, times), times)
    return [ratioSeries('ce_underlying_ratio', 'CE / UL', '#3fb950', call, ul, minDenominator)]
  }
  if (key === 'underlying_pe' && pe) {
    const times = anchor ? anchor.map(c => c.time) : commonTimes(underlying, pe)
    const ul = moveSeries('underlying', 'Underlying', '#79c0ff', alignToTimes(underlying, times), times)
    const put = moveSeries('pe', 'PE', '#bc8cff', alignToTimes(pe, times), times)
    return [ratioSeries('pe_underlying_ratio', 'PE / UL', '#bc8cff', put, ul, minDenominator)]
  }
  if (key === 'ce_pe' && ce && pe) {
    const times = anchor ? anchor.map(c => c.time) : commonTimes(ce, pe)
    const call = moveSeries('ce', 'CE', '#3fb950', alignToTimes(ce, times), times)
    const put = moveSeries('pe', 'PE', '#bc8cff', alignToTimes(pe, times), times)
    return [ratioSeries('ce_pe_ratio', 'CE / PE', '#f0883e', call, put, minDenominator)]
  }
  if (key === 'ce_ul_pe_ul' && ce && pe) {
    const times = anchor
      ? anchor.map(c => c.time)
      : commonTimes(commonTimes(underlying, ce).map(time => ({ time, close: 0 })), pe)
    const ul = moveSeries('underlying', 'Underlying', '#79c0ff', alignToTimes(underlying, times), times)
    const call = moveSeries('ce', 'CE', '#3fb950', alignToTimes(ce, times), times)
    const put = moveSeries('pe', 'PE', '#bc8cff', alignToTimes(pe, times), times)
    const ceUl = ratioSeries('ce_underlying_ratio_inner', 'CE / UL', '#3fb950', call, ul, minDenominator)
    const peUl = ratioSeries('pe_underlying_ratio_inner', 'PE / UL', '#bc8cff', put, ul, minDenominator)
    return [ratioSeries('ce_ul_pe_ul_ratio', '(CE/UL)/(PE/UL)', '#f778ba', ceUl, peUl, minDenominator)]
  }
  return []
}

import { useMemo, useState, type KeyboardEvent } from 'react'
import { useWidth } from './useWidth'

export interface ChartSeries { id: string; label: string; color: string; values: Array<number | null> }

interface Props {
  days: string[]
  series: ChartSeries[]
  format: (value: number) => string
  ariaLabel: string
  selectedDay?: string | null
  onSelectDay?: (date: string) => void
}

const LEFT = 66, RIGHT = 18, TOP = 14, BOTTOM = 34
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''}`

/** A "nice" step (1, 2, 2.5, 5 × 10ⁿ) for about `count` intervals over `span`. */
function niceStep(span: number, count: number): number {
  const raw = span / count
  const power = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / power
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power
}

/** Ticks covering [min, max] and always including 0. */
export function ticksFor(min: number, max: number): number[] {
  const low = Math.min(min, 0), high = Math.max(max, 0)
  if (low === high) return [0, 1]
  const step = niceStep(high - low, 4)
  const first = Math.floor(low / step) * step, last = Math.ceil(high / step) * step
  const ticks: number[] = []
  for (let value = first; value <= last + step / 2; value += step) ticks.push(Math.abs(value) < step / 1e6 ? 0 : value)
  return ticks
}

/**
 * Multi-series line chart over trading days (categorical x axis). A missing value breaks the line (a gap, never 0).
 * Hover or arrow keys pick a day, Enter/click selects it.
 */
export default function MultiLineChart({ days, series, format, ariaLabel, selectedDay, onSelectDay }: Props) {
  const [active, setActive] = useState<number | null>(null)
  // The drawing is in real pixels (viewBox = rendered size), so text and points stay readable on a phone.
  const [box, measured] = useWidth<HTMLDivElement>(1000)
  const W = Math.max(measured, 280), H = W < 560 ? 270 : 330
  const values = series.flatMap(s => s.values).filter((v): v is number => v != null && Number.isFinite(v))
  const ticks = useMemo(() => ticksFor(values.length ? Math.min(...values) : 0, values.length ? Math.max(...values) : 1), [values.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  const min = ticks[0], max = ticks[ticks.length - 1]
  const plotWidth = W - LEFT - RIGHT, plotHeight = H - TOP - BOTTOM
  const x = (index: number) => (days.length <= 1 ? LEFT + plotWidth / 2 : LEFT + (index * plotWidth) / (days.length - 1))
  const y = (value: number) => TOP + plotHeight - ((value - min) / (max - min || 1)) * plotHeight
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotWidth / 72))))
  const lastWithData = Math.max(0, ...series.flatMap(s => s.values.map((v, i) => (v != null ? i : 0))))
  const current = active ?? lastWithData
  const move = (event: KeyboardEvent) => {
    if (!days.length) return
    if (event.key === 'ArrowLeft') { event.preventDefault(); setActive(Math.max(0, current - 1)) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); setActive(Math.min(days.length - 1, current + 1)) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(days.length - 1) }
    else if ((event.key === 'Enter' || event.key === ' ') && onSelectDay) { event.preventDefault(); onSelectDay(days[current]) }
  }
  if (!days.length) return <p className="pa-muted">No trading days in this selection.</p>
  const slot = days.length > 1 ? plotWidth / (days.length - 1) : plotWidth
  return (
    <div ref={box} className="hb-chart" role="group" aria-label={`${ariaLabel}. Use the arrow keys to move between days and Enter to list the day's trades.`} tabIndex={0} onKeyDown={move} onBlur={() => setActive(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={ariaLabel}>
        {ticks.map(tick => (
          <g key={tick}>
            <line x1={LEFT} x2={W - RIGHT} y1={y(tick)} y2={y(tick)} className={tick === 0 ? 'hb-grid zero' : 'hb-grid'} />
            <text x={LEFT - 8} y={y(tick) + 4} textAnchor="end" className="hb-tick">{format(tick)}</text>
          </g>
        ))}
        {days.map((date, index) => (days.length - 1 - index) % labelEvery === 0 && (
          <text key={date} x={x(index)} y={H - 10} textAnchor={index === days.length - 1 && days.length > 1 ? 'end' : 'middle'} className="hb-tick">{shortDate(date)}</text>
        ))}
        {selectedDay && days.includes(selectedDay) && <rect x={x(days.indexOf(selectedDay)) - slot / 2} y={TOP} width={slot} height={plotHeight} className="hb-selected-day" />}
        <line x1={x(current)} x2={x(current)} y1={TOP} y2={TOP + plotHeight} className="hb-cursor" />
        {series.map(s => {
          const segments: string[] = []
          let open = ''
          s.values.forEach((value, index) => {
            if (value == null) { if (open) segments.push(open); open = ''; return }
            open += `${open ? 'L' : 'M'}${x(index).toFixed(1)} ${y(value).toFixed(1)} `
          })
          if (open) segments.push(open)
          return (
            <g key={s.id}>
              {segments.map((d, i) => <path key={i} d={d} fill="none" stroke={s.color} strokeWidth={2.4} strokeLinejoin="round" />)}
              {s.values.map((value, index) => value != null && <circle key={index} cx={x(index)} cy={y(value)} r={index === current ? 5 : 3.2} fill={s.color} />)}
            </g>
          )
        })}
        {days.map((date, index) => (
          <rect key={date} x={x(index) - slot / 2} y={TOP} width={slot} height={plotHeight} fill="transparent" className="hb-hit"
            onMouseEnter={() => setActive(index)} onClick={() => { setActive(index); onSelectDay?.(date) }} />
        ))}
      </svg>
      <p className="hb-readout" aria-live="polite">
        <strong>{shortDate(days[current])}</strong>
        {series.map(s => (
          <span key={s.id}><i style={{ background: s.color }} />{s.label}: {s.values[current] == null ? '—' : format(s.values[current] as number)}</span>
        ))}
      </p>
    </div>
  )
}

import { useMemo, type KeyboardEvent } from 'react'
import { fmtPct, fmtSigned } from './format'
import type { ScatterPoint } from './deepDiveStats'
import type { Unit } from './habitStats'
import { ticksFor } from './MultiLineChart'
import { useWidth } from './useWidth'

interface Props { points: ScatterPoint[]; unit: Unit; ariaLabel: string; onOpen?: (point: ScatterPoint) => void }

const LEFT = 64, RIGHT = 18, TOP = 14, BOTTOM = 40
const OLD = [100, 116, 139], NEW = [56, 189, 248]   // slate → sky: older trades are dim, recent ones bright
const colour = (recency: number) => `rgb(${OLD.map((o, i) => Math.round(o + (NEW[i] - o) * recency)).join(',')})`
const istClock = (epoch: number) => new Date(epoch * 1000).toISOString().slice(11, 16)

/** Capital % (x) against the result of each trade (y). Colour = how recent; click or Enter opens the trade. */
export default function ScatterPlot({ points, unit, ariaLabel, onOpen }: Props) {
  const [box, measured] = useWidth<HTMLDivElement>(1000)
  const W = Math.max(measured, 280), H = W < 560 ? 280 : 340
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  const yTicks = useMemo(() => ticksFor(ys.length ? Math.min(...ys) : 0, ys.length ? Math.max(...ys) : 1), [ys.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  const xTicks = useMemo(() => ticksFor(0, xs.length ? Math.max(...xs) : 1), [xs.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  const plotWidth = W - LEFT - RIGHT, plotHeight = H - TOP - BOTTOM
  const x0 = 0, x1 = xTicks[xTicks.length - 1], y0 = yTicks[0], y1 = yTicks[yTicks.length - 1]
  const px = (v: number) => LEFT + ((v - x0) / (x1 - x0 || 1)) * plotWidth
  const py = (v: number) => TOP + plotHeight - ((v - y0) / (y1 - y0 || 1)) * plotHeight
  if (!points.length) return <p className="pa-muted">No trade has both a capital % and a result to plot.</p>
  const press = (event: KeyboardEvent, point: ScatterPoint) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen?.(point) }
  }
  return (
    <div ref={box} className="hb-scatter">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={ariaLabel}>
        {yTicks.map(t => (
          <g key={`y${t}`}>
            <line x1={LEFT} x2={W - RIGHT} y1={py(t)} y2={py(t)} className={t === 0 ? 'hb-grid zero' : 'hb-grid'} />
            <text x={LEFT - 8} y={py(t) + 4} textAnchor="end" className="hb-tick">{unit === 'pct' ? fmtPct(t, Math.abs(t) < 10 ? 1 : 0) : fmtSigned(t, 'money').replace('+', '')}</text>
          </g>
        ))}
        {xTicks.map(t => (
          <g key={`x${t}`}>
            <line x1={px(t)} x2={px(t)} y1={TOP} y2={TOP + plotHeight} className="hb-grid" />
            <text x={px(t)} y={H - 20} textAnchor="middle" className="hb-tick">{fmtPct(t, 0)}</text>
          </g>
        ))}
        <text x={LEFT + plotWidth / 2} y={H - 3} textAnchor="middle" className="hb-axis">Capital deployed (% of session capital)</text>
        {points.map(point => {
          const label = `${point.trade.date} ${istClock(point.trade.entry_time)}: capital ${fmtPct(point.x, 1)}, result ${fmtSigned(point.y, unit)}`
          return (
            <circle key={point.trade.cycle_id} cx={px(point.x)} cy={py(point.y)} r={5.5} fill={colour(point.recency)} stroke="#0a1020" strokeWidth={1}
              tabIndex={0} role="button" aria-label={`${label}. Open trade`} className="hb-dot" onClick={() => onOpen?.(point)} onKeyDown={event => press(event, point)}>
              <title>{label}</title>
            </circle>
          )
        })}
      </svg>
      <p className="hb-scatter-legend" aria-hidden="true"><span>older</span><i style={{ background: `linear-gradient(90deg, ${colour(0)}, ${colour(1)})` }} /><span>recent</span></p>
    </div>
  )
}

import { fmtSigned, fmtValue } from './format'
import { metric, type HabitSummary, type StatMode, type Unit } from './habitStats'
import { useWidth } from './useWidth'

interface Props { habits: HabitSummary[]; unit: Unit; mode: StatMode }

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

/**
 * Loss (left, red) and profit (right, green) per habit with a marker at the net result; the most destructive habit is
 * first. The drawing uses real pixels: wide screens put the habit name left of its bar, phones put it above the bar.
 * Habits whose trades have no usable P&L % are omitted in % view (nothing to draw).
 */
export default function DivergingBars({ habits, unit, mode }: Props) {
  const [box, measured] = useWidth<HTMLDivElement>(1000)
  const W = Math.max(measured, 280)
  const compact = W < 640
  const rows = habits.map(h => ({
    h,
    loss: metric(h, 'loss', unit, mode) as number | null,
    profit: metric(h, 'profit', unit, mode) as number | null,
    net: metric(h, 'net', unit, mode) as number | null,
  })).filter(r => r.net != null)
  if (!rows.length) return <p className="pa-muted">No habit has a {unit === 'pct' ? 'P&L %' : 'P&L'} to draw yet.</p>
  const extent = Math.max(...rows.flatMap(r => [Math.abs(r.loss ?? 0), Math.abs(r.profit ?? 0), Math.abs(r.net ?? 0)]), 1e-9)
  const LABEL = compact ? 0 : Math.min(250, W * 0.26), VALUE = compact ? 0 : 130
  const ROW = compact ? 56 : 34, TOP = 26, BAR = compact ? 18 : ROW - 14
  const plotLeft = LABEL + (compact ? 8 : 0), plotRight = W - VALUE - (compact ? 8 : 0)
  const plotWidth = plotRight - plotLeft
  const zero = plotLeft + plotWidth / 2
  const x = (value: number) => zero + (value / extent) * (plotWidth / 2)
  const height = TOP + rows.length * ROW + 8
  const summary = rows.map(r => `${r.h.text}: net ${fmtSigned(r.net, unit)}`).join('; ')
  return (
    <div ref={box} className="hb-diverging-box">
      <svg className="hb-diverging" viewBox={`0 0 ${W} ${height}`} width={W} height={height} role="img" aria-label={`Net result per habit, most destructive first. ${summary}`}>
        <text x={x(-extent / 2)} y={14} className="hb-axis" textAnchor="middle">Losses</text>
        <text x={x(extent / 2)} y={14} className="hb-axis" textAnchor="middle">Profits</text>
        <line x1={zero} x2={zero} y1={TOP - 6} y2={height - 4} className="hb-zero" />
        {rows.map(({ h, loss, profit, net }, index) => {
          const y = TOP + index * ROW
          const barTop = compact ? y + 22 : y + 7
          const title = `${h.text} (${h.kind}) — loss ${fmtValue(loss, unit)}, profit ${fmtValue(profit, unit)}, net ${fmtSigned(net, unit)} over ${h.habit.trades} trades`
          const tone = (net as number) >= 0 ? 'positive' : 'negative'
          return (
            <g key={h.question_id} tabIndex={0} role="img" aria-label={title} className={h.status === 'archived' ? 'hb-row archived' : 'hb-row'}>
              <title>{title}</title>
              {compact
                ? <text x={8} y={y + 14} className="hb-label">{clip(h.text, Math.max(12, Math.floor((W - 96) / 7.5)))}</text>
                : <text x={LABEL - 10} y={y + 20} textAnchor="end" className="hb-label">{clip(h.text, Math.max(14, Math.floor(LABEL / 7.2)))}</text>}
              {loss != null && loss < 0 && <rect x={x(loss)} y={barTop} width={zero - x(loss)} height={BAR} className="hb-loss" rx={2} />}
              {profit != null && profit > 0 && <rect x={zero} y={barTop} width={x(profit) - zero} height={BAR} className="hb-profit" rx={2} />}
              <path d={`M ${x(net as number)} ${barTop - 3} l 5 ${(BAR + 6) / 2} l -5 ${(BAR + 6) / 2} l -5 -${(BAR + 6) / 2} z`} className={`hb-net ${tone}`} />
              {compact
                ? <text x={W - 8} y={y + 14} textAnchor="end" className={`hb-value ${tone}`}>{fmtSigned(net, unit)}</text>
                : <text x={W - VALUE + 10} y={y + 20} className={`hb-value ${tone}`}>{fmtSigned(net, unit)}</text>}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

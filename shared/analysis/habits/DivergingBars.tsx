import { fmtSigned, fmtValue } from './format'
import { metric, type HabitSummary, type StatMode, type Unit } from './habitStats'

interface Props { habits: HabitSummary[]; unit: Unit; mode: StatMode }

const WIDTH = 1000, LABEL = 250, VALUE = 150, ROW = 34, TOP = 26
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

/**
 * Loss (left, red) and profit (right, green) per habit with a marker at the net result; the most destructive habit is
 * first. Habits whose trades have no usable P&L % are omitted in % view (nothing to draw).
 */
export default function DivergingBars({ habits, unit, mode }: Props) {
  const rows = habits.map(h => ({
    h,
    loss: metric(h, 'loss', unit, mode) as number | null,
    profit: metric(h, 'profit', unit, mode) as number | null,
    net: metric(h, 'net', unit, mode) as number | null,
  })).filter(r => r.net != null)
  if (!rows.length) return <p className="pa-muted">No habit has a {unit === 'pct' ? 'P&L %' : 'P&L'} to draw yet.</p>
  const extent = Math.max(...rows.flatMap(r => [Math.abs(r.loss ?? 0), Math.abs(r.profit ?? 0), Math.abs(r.net ?? 0)]), 1e-9)
  const plotWidth = WIDTH - LABEL - VALUE
  const zero = LABEL + plotWidth / 2
  const x = (value: number) => zero + (value / extent) * (plotWidth / 2)
  const height = TOP + rows.length * ROW + 8
  const summary = rows.map(r => `${r.h.text}: net ${fmtSigned(r.net, unit)}`).join('; ')
  return (
    <svg className="hb-diverging" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={`Net result per habit, most destructive first. ${summary}`}>
      <text x={x(-extent / 2)} y={14} className="hb-axis" textAnchor="middle">Losses</text>
      <text x={x(extent / 2)} y={14} className="hb-axis" textAnchor="middle">Profits</text>
      <line x1={zero} x2={zero} y1={TOP - 6} y2={height - 4} className="hb-zero" />
      {rows.map(({ h, loss, profit, net }, index) => {
        const y = TOP + index * ROW
        const title = `${h.text} (${h.kind}) — loss ${fmtValue(loss, unit)}, profit ${fmtValue(profit, unit)}, net ${fmtSigned(net, unit)} over ${h.habit.trades} trades`
        return (
          <g key={h.question_id} tabIndex={0} role="img" aria-label={title} className={h.status === 'archived' ? 'hb-row archived' : 'hb-row'}>
            <title>{title}</title>
            <text x={LABEL - 10} y={y + 20} textAnchor="end" className="hb-label">{clip(h.text, 34)}</text>
            {loss != null && loss < 0 && <rect x={x(loss)} y={y + 6} width={zero - x(loss)} height={ROW - 14} className="hb-loss" rx={2} />}
            {profit != null && profit > 0 && <rect x={zero} y={y + 6} width={x(profit) - zero} height={ROW - 14} className="hb-profit" rx={2} />}
            <path d={`M ${x(net as number)} ${y + 3} l 5 ${(ROW - 6) / 2} l -5 ${(ROW - 6) / 2} l -5 -${(ROW - 6) / 2} z`} className={`hb-net ${(net as number) >= 0 ? 'positive' : 'negative'}`} />
            <text x={WIDTH - VALUE + 10} y={y + 20} className={`hb-value ${(net as number) >= 0 ? 'positive' : 'negative'}`}>{fmtSigned(net, unit)}</text>
          </g>
        )
      })}
    </svg>
  )
}

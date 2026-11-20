/** A small accessible line chart in plain SVG (no chart library, spec 7.1). */
interface Props {
  values: number[]
  /** Fixed vertical range (scores: 0 to 100); omit to fit the values. */
  min?: number
  max?: number
  width?: number
  height?: number
  /** Said by screen readers instead of the picture. */
  label: string
}

export function Sparkline({ values, min, max, width = 160, height = 34, label }: Props) {
  if (!values.length) return <span className="games-meta" role="img" aria-label={`${label}: no data yet`}>no data yet</span>
  const lo = min ?? Math.min(...values)
  const hi = max ?? Math.max(...values)
  const span = hi - lo || 1
  const pad = 3
  const x = (i: number) => (values.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (values.length - 1))
  const y = (v: number) => height - pad - ((Math.min(hi, Math.max(lo, v)) - lo) / span) * (height - 2 * pad)
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <svg className="games-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.6} fill="currentColor" />
    </svg>
  )
}

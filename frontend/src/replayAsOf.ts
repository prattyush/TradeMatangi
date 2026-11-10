/**
 * Market time (HH:MM:SS, the IST wall clock) that a replay chart may show history up to.
 *
 * `simTs` is the replay clock as Unix seconds in the IST-as-UTC convention. It only counts when it is
 * on the chart's trading date: a stale clock from another date must never cut or poison the history.
 * Returns null when there is no usable clock.
 */
export function replayAsOfTime(simTs: number | null | undefined, tradingDate: string): string | null {
  if (typeof simTs !== 'number' || !Number.isFinite(simTs) || simTs <= 0) return null
  if (new Date(simTs * 1000).toISOString().slice(0, 10) !== tradingDate) return null
  const secs = Math.floor(simTs) % 86400
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

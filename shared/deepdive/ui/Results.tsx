import { useMemo, useState } from 'react'
import { readableError } from '../../analysis/behavior/types'
import { computeStats, formatDay, formatPct, nLabel, SIDE_MEANING, sideLabel, sortTagStats, successLine, tagDots, thinNote } from '../model'
import type { Dive, DiveSetup, Side } from '../types'
import { useDeepDiveHost } from './host'

interface Props {
  dive: Dive
  onOpenDay: (day: DiveSetup) => void
}

type SideFilter = 'all' | Side
const dayId = (day: DiveSetup) => `${day.date}|${day.symbol}|${day.side}`

/**
 * Step 3 of a deep dive: what the marked days say. Per tag, how often it was valid over the days it was marked (with n and a
 * warning while the sample is thin), the success rate, and a row per day. Filter by Buy or Sell; open a day in the in-depth
 * step; copy a day's chart marks into the Pattern Library. Percentages are worked out from the days on screen, with the same
 * arithmetic as the server's, so they always include the latest change.
 */
export default function Results({ dive, onOpenDay }: Props) {
  const { api } = useDeepDiveHost()
  const [side, setSide] = useState<SideFilter>('all')
  const [order, setOrder] = useState<'tags' | 'frequent'>('tags')
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const stats = useMemo(() => computeStats(dive.setups, dive.tags, side === 'all' ? null : side), [dive.setups, dive.tags, side])
  const rows = order === 'frequent' ? sortTagStats(stats.tags) : stats.tags
  const days = useMemo(() => dive.setups.filter(day => side === 'all' || day.side === side), [dive.setups, side])
  const withMarks = days.filter(day => day.annotations.length > 0)
  const counts = { all: dive.setups.length, buy: dive.setups.filter(d => d.side === 'buy').length, sell: dive.setups.filter(d => d.side === 'sell').length }

  const describe = (day: DiveSetup, result: { merged: boolean; added: number }) =>
    `${formatDay(day.date)} ${sideLabel(day.side)}: ${result.merged ? `added ${result.added} ${result.added === 1 ? 'mark' : 'marks'} to the existing pattern chart` : `saved as a new pattern chart with ${result.added} ${result.added === 1 ? 'mark' : 'marks'}`}`

  const saveDay = async (day: DiveSetup) => {
    setBusy(dayId(day)); setMessage(null)
    try { setMessage({ kind: 'ok', text: describe(day, await api.saveToPatterns(day)) }) }
    catch (error) { setMessage({ kind: 'error', text: `${formatDay(day.date)} ${sideLabel(day.side)}: ${readableError(error)}` }) }
    finally { setBusy(null) }
  }
  const saveAll = async () => {
    setBusy('all'); setMessage(null)
    let created = 0, merged = 0, added = 0
    const failed: string[] = []
    for (const day of withMarks) {
      try { const result = await api.saveToPatterns(day); if (result.merged) merged += 1; else created += 1; added += result.added }
      catch (error) { failed.push(`${formatDay(day.date)} ${sideLabel(day.side)} (${readableError(error)})`) }
    }
    setBusy(null)
    const done = `${created} new and ${merged} updated pattern ${created + merged === 1 ? 'chart' : 'charts'}, ${added} marks added`
    setMessage(failed.length ? { kind: 'error', text: `${done}. Not saved: ${failed.join('; ')}` } : { kind: 'ok', text: done })
  }

  if (!dive.setups.length) return <p className="pl-muted">No days are marked yet, so there is nothing to count.</p>

  return <div className="dd-results">
    <div className="pl-bar">
      <div className="pl-tabs" role="group" aria-label="Show setups">
        {(['all', 'buy', 'sell'] as const).map(choice => <button key={choice} aria-pressed={side === choice} className={`dd-filter ${choice}`} onClick={() => setSide(choice)}
          title={choice === 'all' ? 'Buy and Sell setups together' : choice === 'buy' ? 'Buy setups: long / bullish' : 'Sell setups: short / bearish'}>
          {choice === 'all' ? 'All' : sideLabel(choice)} ({counts[choice]})
        </button>)}
      </div>
      <label className="pl-muted">Order <select value={order} onChange={e => setOrder(e.target.value as 'tags' | 'frequent')}>
        <option value="tags">Tag order</option><option value="frequent">Most frequent first</option></select></label>
      {dive.can_edit && <button onClick={() => void saveAll()} disabled={busy !== null || withMarks.length === 0}
        title="Copy the chart marks of the days shown into the Pattern Library">Save {withMarks.length} marked {withMarks.length === 1 ? 'day' : 'days'} to Pattern Library</button>}
    </div>
    <p className="pl-muted dd-meaning">{SIDE_MEANING}</p>
    {message && <p className={message.kind === 'error' ? 'pl-error' : 'pl-ok'} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p>}

    <div className="dd-summary">
      <strong>{stats.days} {stats.days === 1 ? 'day' : 'days'}</strong>
      <span className="pl-muted">{stats.buy_days} buy · {stats.sell_days} sell</span>
      <span>{successLine(stats)}</span>
      {thinNote(stats.with_outcome) && stats.with_outcome > 0 && <span className="dd-thin">{thinNote(stats.with_outcome)}</span>}
    </div>

    <h4>How often each tag was valid</h4>
    {rows.length === 0 ? <p className="pl-muted">No tags yet. Add tags in the in-depth step to see how often each one shows up.</p> : <ul className="dd-freq">
      {rows.map(row => <li key={row.tag_id}>
        <span className="dd-freq-name">{row.name}</span>
        <span className="dd-bar" role="img" aria-label={`${row.name}: ${formatPct(row.pct)} valid, ${nLabel(row.marked)}`}><span style={{ width: `${row.pct ?? 0}%` }} className={row.few_days ? 'thin' : ''} /></span>
        <span className="dd-freq-pct">{formatPct(row.pct)} <span className="pl-muted">({nLabel(row.marked)})</span></span>
        <span className="pl-muted dd-freq-counts">{row.valid} valid · {row.not_valid} not valid</span>
        {thinNote(row.marked) && <span className="dd-thin">{thinNote(row.marked)}</span>}
      </li>)}
    </ul>}

    <h4>Days</h4>
    <table className="dd-table dd-days-table">
      <thead><tr><th>Date</th><th>Setup</th><th>Outcome</th><th>Tags</th><th>Marks</th><th>Notes</th><th /></tr></thead>
      <tbody>{days.map(day => <tr key={dayId(day)}>
        <td><button className="dd-day-link" onClick={() => onOpenDay(day)} title="Open this day in the in-depth step">{formatDay(day.date)}</button></td>
        <td><span className={`dd-side-tag ${day.side}`}>{sideLabel(day.side)}</span> <span className="pl-muted">{day.symbol}</span></td>
        <td>{day.outcome === 'success' ? <span className="dd-ok">Success</span> : day.outcome === 'failed' ? <span className="dd-bad">Failed</span> : <span className="pl-muted">—</span>}</td>
        <td><span className="dd-dots">{tagDots(day, dive.tags).map(dot => <span key={dot.tag_id} className={`dd-dot ${dot.state}`} title={`${dot.name}: ${dot.state === 'valid' ? 'valid' : dot.state === 'not_valid' ? 'not valid' : 'not marked'}`} />)}</span></td>
        <td>{day.annotations.length || <span className="pl-muted">—</span>}</td>
        <td className="dd-notes-cell" title={day.notes}>{day.notes}</td>
        <td className="pl-actions">
          <button onClick={() => onOpenDay(day)}>Open</button>
          {dive.can_edit && day.annotations.length > 0 && <button onClick={() => void saveDay(day)} disabled={busy !== null} title="Copy this day's chart marks into the Pattern Library">{busy === dayId(day) ? 'Saving…' : 'Save to Patterns'}</button>}
        </td>
      </tr>)}</tbody>
    </table>
  </div>
}

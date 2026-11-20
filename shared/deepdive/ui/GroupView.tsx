import { useMemo, useState } from 'react'
import { computeGroupStats, formatDay, GROUP_CELLS, groupCellLabel, shareLine, sideLabel, thinNote } from '../model'
import type { GroupCell, GroupDay, GroupShare, GroupTag, Side } from '../types'
import './groupView.css'

interface Props<D extends GroupDay> {
  days: readonly D[]
  /** The tags that can be paired (the dive's active tags). */
  tags: readonly GroupTag[]
  /** Which side to start on; null for both. */
  initialSide?: Side | null
  /** The small version for the label popups: no day lists, no side switch of its own. */
  compact?: boolean
  /** Full version: open a listed day. */
  onOpenDay?: (day: D) => void
}

const SideNote = ({ value }: { value: GroupShare }) => {
  const note = value.of ? thinNote(value.of) : null
  return note ? <span className="dd-thin">{note.replace('marked', 'counted')}</span> : null
}

/**
 * Two tags together: how often they happened on the same day. Pick tag A and tag B; only days where BOTH are marked count (the
 * others are listed as not counted). Shows the four ways the pair can fall (AND true, one without the other, neither) and the
 * conditional rates: of the days A was valid, how often B was, and of the days A was not valid, how often B was.
 * Shared by Results (with day lists) and the live label popups (compact).
 */
export default function GroupView<D extends GroupDay>({ days, tags, initialSide = null, compact = false, onOpenDay }: Props<D>) {
  const [aId, setAId] = useState(tags[0]?.tag_id ?? '')
  const [bId, setBId] = useState(tags[1]?.tag_id ?? '')
  const [side, setSide] = useState<Side | null>(initialSide)
  const [open, setOpen] = useState<GroupCell | 'not_counted' | null>(null)
  const a = tags.find(tag => tag.tag_id === aId) ?? tags[0]
  const b = tags.find(tag => tag.tag_id === bId && tag.tag_id !== a?.tag_id) ?? tags.find(tag => tag.tag_id !== a?.tag_id)
  const stats = useMemo(() => (a && b ? computeGroupStats(days, a, b, side) : null), [days, a, b, side])

  if (tags.length < 2) return <p className="pl-muted dd-stats-note">Group needs two tags. Add another tag to this deep dive first.</p>
  if (!a || !b || !stats) return null
  const picker = (label: string, value: string, other: string, set: (id: string) => void) => (
    <label className="dd-group-pick">{label} <select aria-label={`Tag ${label}`} value={value} onChange={event => { set(event.target.value); setOpen(null) }}>
      {tags.map(tag => <option key={tag.tag_id} value={tag.tag_id} disabled={tag.tag_id === other}>{tag.name}</option>)}</select></label>
  )
  const notCounted = days.filter(day => (side === null || day.side === side) && !(a.tag_id in day.tag_values && b.tag_id in day.tag_values))
  const listed = open === 'not_counted' ? notCounted : open ? stats.cells[open] : []
  return <div className={`dd-group${compact ? ' compact' : ''}`} role="region" aria-label="Two tags together">
    <div className="dd-group-pickers">
      {picker('A', a.tag_id, b.tag_id, setAId)}
      {picker('B', b.tag_id, a.tag_id, setBId)}
      <button type="button" className="dd-group-swap" title="Swap A and B" onClick={() => { setAId(b.tag_id); setBId(a.tag_id); setOpen(null) }}>⇄</button>
      {!compact && <span className="pl-muted dd-group-sides" role="group" aria-label="Group side">
        {([null, 'buy', 'sell'] as const).map(choice => <button key={choice ?? 'all'} type="button" aria-pressed={side === choice} className={`dd-filter ${choice ?? ''}`}
          onClick={() => { setSide(choice); setOpen(null) }}>{choice === null ? 'All' : sideLabel(choice)}</button>)}
      </span>}
    </div>
    {stats.counted === 0
      ? <p className="pl-muted dd-stats-note">No day has both tags marked yet{side ? ` on the ${sideLabel(side)} side` : ''}.</p>
      : <>
        <p className="dd-group-conditional" data-testid="group-conditional">
          <span>When <b>{a.name}</b> was valid, <b>{b.name}</b> was valid <strong>{shareLine(stats.b_given_a)}</strong> <SideNote value={stats.b_given_a} /></span>
          <span>When <b>{a.name}</b> was not valid, <b>{b.name}</b> was valid <strong>{shareLine(stats.b_given_not_a)}</strong> <SideNote value={stats.b_given_not_a} /></span>
          {!compact && <span className="pl-muted">When <b>{b.name}</b> was valid, <b>{a.name}</b> was valid {shareLine(stats.a_given_b)}</span>}
        </p>
        <table className="dd-table dd-group-table">
          <tbody>{GROUP_CELLS.map(cell => <tr key={cell} data-cell={cell}>
            <td>{compact || stats.cells[cell].length === 0 ? groupCellLabel(cell, a.name, b.name)
              : <button type="button" className="dd-day-link" aria-pressed={open === cell} onClick={() => setOpen(open === cell ? null : cell)}>{groupCellLabel(cell, a.name, b.name)}</button>}</td>
            <td className="dd-group-n">{stats.counts[cell].n}</td>
            <td className="dd-group-pct">{shareLine(stats.counts[cell])}</td>
          </tr>)}</tbody>
        </table>
      </>}
    <p className="pl-muted dd-stats-note" data-testid="group-not-counted">
      {stats.counted} {stats.counted === 1 ? 'day' : 'days'} counted (both tags marked)
      {stats.not_counted > 0 && <>, {compact || !notCounted.length ? `${stats.not_counted} not counted` : <button type="button" className="dd-day-link" aria-pressed={open === 'not_counted'} onClick={() => setOpen(open === 'not_counted' ? null : 'not_counted')}>{stats.not_counted} not counted</button>} (one of the two tags is not marked on them)</>}
    </p>
    {!compact && open && listed.length > 0 && <ul className="dd-group-days" aria-label="Days">
      {listed.map(day => <li key={`${day.date}|${day.symbol ?? ''}|${day.side}`}>
        {onOpenDay ? <button type="button" className="dd-day-link" onClick={() => onOpenDay(day)}>{formatDay(day.date)}</button> : formatDay(day.date)} <span className={`dd-side-tag ${day.side}`}>{sideLabel(day.side)}</span>
        {open === 'not_counted' && <span className="pl-muted"> {[a, b].filter(tag => !(tag.tag_id in day.tag_values)).map(tag => tag.name).join(', ')} not marked</span>}
      </li>)}
    </ul>}
  </div>
}

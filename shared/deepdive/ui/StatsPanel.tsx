import { useEffect, useState } from 'react'
import { blockFor, defaultSideForTrade, findStats, formatPct, nLabel, SIDE_MEANING, sideLabel, sortTagStats, strengthLine, successLine, thinNote } from '../model'
import type { Side, StatsAllEntry } from '../types'
import './statsPanel.css'

interface Props {
  entries: readonly StatsAllEntry[]
  category: string
  strategy: string
  /** The position being labelled: its option right (null for equity or an index) and the side of the order that opened it. */
  trade: { right?: string | null; action?: string | null }
  /** The most frequent tags shown; the rest are counted. */
  limit?: number
}

/**
 * What the user's own Deep Dive says about the expected strategy, shown in the label forms: how often each tag was valid, and
 * the success rate. It opens on the side the position belongs to (long equity, CE bought and PE sold are Buy; short equity, PE
 * bought and CE sold are Sell) with a switch to the other side or All. Renders nothing when the strategy has no deep dive.
 */
export default function StatsPanel({ entries, category, strategy, trade, limit = 6 }: Props) {
  const entry = findStats(entries, category, strategy)
  const own = defaultSideForTrade(trade)
  const [side, setSide] = useState<Side | 'all'>(own)
  useEffect(() => { setSide(own) }, [own, category, strategy])
  if (!entry) return null
  const block = blockFor(entry, side)
  const rows = sortTagStats(block.tags)
  const counts = { all: entry.all.days, buy: entry.buy.days, sell: entry.sell.days }
  return <div className="dd-stats" role="region" aria-label="Deep dive frequencies">
    <div className="dd-stats-head">
      <strong>Your deep dive</strong>
      {entry.shared && <span className="dd-stats-note">shared with you</span>}
      {own !== 'all' && <span className="dd-stats-note" title={SIDE_MEANING}>this position is {sideLabel(own)}-side</span>}
    </div>
    <div className="dd-stats-sides" role="group" aria-label="Show setups">
      {(['all', 'buy', 'sell'] as const).map(choice => <button key={choice} type="button" aria-pressed={side === choice} className={choice}
        title={choice === 'all' ? 'Buy and Sell setups together' : choice === 'buy' ? 'Buy setups: long / bullish' : 'Sell setups: short / bearish'}
        onClick={() => setSide(choice)}>{choice === 'all' ? 'All' : sideLabel(choice)} ({counts[choice]})</button>)}
    </div>
    {block.days === 0 ? <p className="dd-stats-note">No {side === 'all' ? '' : `${sideLabel(side)} `}days in this deep dive.</p> : <>
      {rows.length === 0 ? <p className="dd-stats-note">This deep dive has no tags yet.</p> : <ul>
        {rows.slice(0, limit).map(row => <li key={row.tag_id}>
          <span className="dd-stats-name">{row.name}</span>
          <span className="dd-stats-pct">{formatPct(row.pct)} <span className="dd-stats-n">({nLabel(row.marked)})</span></span>
          {thinNote(row.marked) && <span className="dd-stats-thin">{thinNote(row.marked)}</span>}
        </li>)}
      </ul>}
      {rows.length > limit && <p className="dd-stats-note">+{rows.length - limit} more in the deep dive</p>}
      <p className="dd-stats-success">{successLine(block)}{strengthLine(block) ? ` · ${strengthLine(block)}` : ''}</p>
    </>}
  </div>
}

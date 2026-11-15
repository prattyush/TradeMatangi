import { useMemo, useState } from 'react'
import type { EventSnapshot } from '../../../../../shared/analysis/api'
import { eventIcon, filterSnapshots } from '../../../../../shared/analysis/snapshotModel'
import { Sheet } from '../../../shell/Sheet'
import { clockTime } from '../format'

const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`

/** Every captured event of the day, newest chart state first-class: search, then tap one to open its snapshot. */
export function EventListSheet({ snapshots, selected, onSelect, onClose }: {
  snapshots: EventSnapshot[]; selected: number; onSelect: (index: number) => void; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => filterSnapshots(snapshots, query), [snapshots, query])
  return (
    <Sheet title="Events" onClose={onClose}>
      <label>
        Search (* matches anything)
        <input type="text" value={query} placeholder="fill*, stoploss, edited…" autoCapitalize="none" autoCorrect="off" onChange={event => setQuery(event.target.value)} />
      </label>
      <div className="event-list" role="list">
        {shown.length === 0 && <p className="muted">No matching events</p>}
        {shown.map(snapshot => {
          const index = snapshots.indexOf(snapshot)
          const data = snapshot.snapshot
          const result = data.session_pnl_pct != null ? `S ${pct(data.session_pnl_pct)}` : data.position.side !== 'FLAT' ? `P ${pct(data.position.pnl_pct)}` : ''
          return (
            <button key={`${snapshot.session_id}:${snapshot.event_id}`} type="button" role="listitem" className="event-row" aria-current={index === selected ? 'true' : undefined}
              onClick={() => { onSelect(index); onClose() }}>
              <span className="event-row-time mono">{clockTime(snapshot.timestamp)}</span>
              <span className="event-row-what">
                <strong>{eventIcon(snapshot.event.type)} {snapshot.event.description}</strong>
                <small>{snapshot.event.type.replace(/_/g, ' ')}</small>
              </span>
              {result && <span className={`event-row-pnl ${(data.session_pnl ?? data.position.pnl) >= 0 ? 'pos' : 'neg'}`}>{result}</span>}
            </button>
          )
        })}
      </div>
    </Sheet>
  )
}

import { useMemo, useState } from 'react'
import { Sheet } from '../../shell/Sheet'
import { searchInstruments, type Instrument } from './browseModel'

/** Pick a symbol: type to search the catalogue; recent symbols are listed first when nothing is typed. */
export function SymbolSheet({ instruments, current, recents, onPick, onClose }: {
  instruments: Instrument[]; current: string; recents: string[]; onPick: (symbol: string) => void; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const results = useMemo(() => searchInstruments(instruments, query), [instruments, query])
  const recentItems = useMemo(
    () => (query.trim() ? [] : recents.map(symbol => instruments.find(item => item.symbol === symbol)).filter((item): item is Instrument => !!item)),
    [instruments, recents, query],
  )
  const row = (item: Instrument) => (
    <button key={item.symbol} type="button" className="symbol-row" aria-current={item.symbol === current ? 'true' : undefined} onClick={() => onPick(item.symbol)}>
      <strong>{item.display_name}</strong>
      <small>{item.symbol}{item.option_eligible ? ' · options' : ''}</small>
    </button>
  )
  return (
    <Sheet title="Symbol" onClose={onClose}>
      <input
        type="search" className="symbol-search" aria-label="Search symbols" placeholder="Search name or symbol" value={query}
        autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus onChange={event => setQuery(event.target.value)}
      />
      {recentItems.length > 0 && (
        <div role="group" aria-label="Recent">
          <h4 className="symbol-group">Recent</h4>
          {recentItems.map(row)}
        </div>
      )}
      <div role="group" aria-label="All symbols">
        {!query.trim() && recentItems.length > 0 && <h4 className="symbol-group">All</h4>}
        {results.map(row)}
        {results.length === 0 && <p className="muted">No matching symbols.</p>}
      </div>
    </Sheet>
  )
}

import { useId, useState } from 'react'

export interface SymbolChoice { symbol: string; display_name: string; chart_type?: string; nse_symbol?: string; option_eligible?: boolean }

/** One catalogue picker for website/desktop; selection remains explicit. */
export function SymbolSearch({ value, options, onChange, disabled = false }: {
  value: string; options: SymbolChoice[]; onChange: (symbol: string) => void; disabled?: boolean
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const selected = options.find(item => item.symbol === value)
  const matches = options.filter(item => `${item.symbol} ${item.nse_symbol ?? ''} ${item.display_name}`.toLowerCase().includes(query.trim().toLowerCase()))
  const indices = matches.filter(item => item.chart_type === 'index' || ['NIFTY', 'BSESEN'].includes(item.symbol))
  const equities = matches.filter(item => !indices.includes(item))
  const ordered = [...indices, ...equities]
  const choose = (symbol: string) => { onChange(symbol); setOpen(false); setQuery(''); setActive(0) }
  return <span style={{ display: 'inline-block', position: 'relative', minWidth: 190 }}>
    <input role="combobox" aria-label="Symbol" autoComplete="off" aria-autocomplete="list" aria-expanded={open}
      aria-controls={`${id}-list`} aria-activedescendant={open && ordered[active] ? `${id}-${ordered[active].symbol}` : undefined}
      disabled={disabled} placeholder="Search name or symbol" value={open ? query : selected?.display_name ?? value}
      style={{ width: '100%', boxSizing: 'border-box' }}
      onFocus={() => { setOpen(true); setQuery(''); setActive(0) }}
      onChange={event => { setQuery(event.target.value); setOpen(true); setActive(0) }}
      onBlur={() => { setOpen(false); setQuery('') }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); setQuery('') }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true)
          setActive(index => Math.max(0, Math.min(ordered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
        }
        if (event.key === 'Enter' && open && ordered[active]) { event.preventDefault(); choose(ordered[active].symbol) }
      }} />
    {open && !disabled && <div id={`${id}-list`} role="listbox" aria-label="Matching symbols" style={{ position: 'absolute', top: '100%', left: 0,
      width: 'max-content', minWidth: '100%', maxWidth: 360, maxHeight: 260, overflowY: 'auto', zIndex: 1000,
      border: '1px solid #475569', borderRadius: 4, background: '#161b22', color: '#e5e7eb', boxShadow: '0 6px 16px #0008' }}>
      {[['Indices', indices], ['Equities', equities]].map(([name, items]) => {
        const group = items as SymbolChoice[]
        return group.length ? <div role="group" aria-label={String(name)} key={String(name)}>
          <div style={{ padding: '4px 8px', color: '#94a3b8', fontSize: 11 }}>{String(name)}</div>
          {group.map(item => <div key={item.symbol} id={`${id}-${item.symbol}`} role="option" aria-label={item.display_name}
            aria-selected={item.symbol === value} onMouseDown={event => { event.preventDefault(); choose(item.symbol) }}
            onMouseEnter={() => setActive(ordered.indexOf(item))}
            style={{ padding: '6px 8px', cursor: 'pointer', fontSize: 12, background: ordered[active] === item ? '#334155' : undefined }}>
            {item.display_name} <small style={{ color: '#94a3b8' }}>{item.nse_symbol ?? item.symbol}</small>
          </div>)}
        </div> : null
      })}
      {!ordered.length && <div style={{ padding: 8 }}>No matching symbols</div>}
    </div>}
  </span>
}

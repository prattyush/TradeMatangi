import { useCallback, useEffect, useRef, useState } from 'react'
import { AnalysisProvider } from '../../../shared/analysis/environment'
import DesktopAnalysisChart from '../AnalysisChart'
import '../../../shared/analysis/kline/desktopAnalysis.css'
import './patternTools.css'
import type { ChartStructureItem, PatternsClient, StructureCandle, StructureType, StructureTypes } from '../patternsClient'
import { usePatternsRuntime } from './usePatternsRuntime'
import FineStructures from './FineStructures'
import { classificationOf, saveMode, shortLabel, sparklinePoints, toggleValue, typeColor } from './chartStructuresModel'

interface Props { baseUrl: string; token: string; onUnauthorized: () => void; active: boolean }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const Badge = ({ value, label }: { value: string; label?: string }) =>
  <span className="cs-badge" style={{ background: typeColor(value) }}>{label ?? shortLabel(value)}</span>

function MultiSelect({ label, options, selected, onChange }: { label: string; options: StructureType[]; selected: string[]; onChange: (v: string[]) => void }) {
  return <details className="cs-multi">
    <summary>{label}: {selected.length ? `${selected.length} selected` : 'All'}</summary>
    <div className="cs-multi-menu">
      {options.map(o => <label key={o.value}><input type="checkbox" checked={selected.includes(o.value)} onChange={() => onChange(toggleValue(selected, o.value))} /><Badge value={o.value} label={o.label} /></label>)}
      {selected.length > 0 && <button onClick={() => onChange([])}>Clear</button>}
    </div>
  </details>
}

/** Close-price line for one day; fetched only once the card scrolls into view (the gallery can hold hundreds of days). */
function Sparkline({ client, item }: { client: PatternsClient; item: ChartStructureItem }) {
  const host = useRef<HTMLDivElement>(null)
  const [candles, setCandles] = useState<StructureCandle[] | null>(null)
  useEffect(() => {
    const node = host.current
    if (!node) return
    let cancelled = false
    const load = () => { void client.structureOhlc(item.symbol, item.date, 15, 1).then(d => { if (!cancelled) setCandles(d.candles) }).catch(() => { if (!cancelled) setCandles([]) }) }
    if (typeof IntersectionObserver === 'undefined') { load(); return () => { cancelled = true } }
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { observer.disconnect(); load() } })
    observer.observe(node)
    return () => { cancelled = true; observer.disconnect() }
  }, [client, item.symbol, item.date])
  const points = candles ? sparklinePoints(candles, item.date, 200, 40) : ''
  return <div ref={host} className="cs-spark">{points && <svg viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} fill="none" stroke="#3b82f6" strokeWidth="1.2" vectorEffect="non-scaling-stroke" /></svg>}</div>
}

function DayView({ client, item, structures, types, historicalDays, onNavigate, onClose, onSaved }: {
  client: PatternsClient; item: ChartStructureItem; structures: ChartStructureItem[]; types: StructureTypes; historicalDays: number
  onNavigate: (item: ChartStructureItem) => void; onClose: () => void; onSaved: () => void
}) {
  const [structure, setStructure] = useState(item)
  const [edit, setEdit] = useState(() => classificationOf(item))
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  useEffect(() => { setStructure(item); setEdit(classificationOf(item)); setMessage(null) }, [item])
  const index = structures.findIndex(s => s.chart_structure_id === item.chart_structure_id)
  const editable = structure.can_delete
  const save = async () => {
    try {
      const saved = saveMode(structure) === 'create'
        ? await client.createStructure({ symbol: structure.symbol, date: structure.date, ...edit })
        : await client.updateStructure(structure.chart_structure_id, edit)
      setStructure(saved); setMessage({ kind: 'ok', text: 'Saved' }); onSaved()
    } catch (error) { setMessage({ kind: 'error', text: errorText(error) }) }
  }
  const field = (label: string, key: keyof typeof edit, options: StructureType[]) =>
    <label>{label} <select value={edit[key]} onChange={e => setEdit(prev => ({ ...prev, [key]: e.target.value }))}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
  return <div className="cs-day">
    <div className="pl-bar">
      <button onClick={onClose}>← Gallery</button>
      <strong>{item.symbol} — {item.date}</strong>
      <span className="pl-muted">{index + 1} of {structures.length}</span>
      <button onClick={() => onNavigate(structures[index - 1])} disabled={index <= 0} aria-label="Previous day">‹</button>
      <button onClick={() => onNavigate(structures[index + 1])} disabled={index < 0 || index >= structures.length - 1} aria-label="Next day">›</button>
      <Badge value={structure.opening_type} /><Badge value={structure.midday_type} /><Badge value={structure.closing_type} />
      {structure.is_predefined && <span className="pl-muted">System classification</span>}
      {!structure.is_predefined && !structure.can_delete && <span className="pl-muted">Shared</span>}
    </div>
    <div className="cs-chart"><DesktopAnalysisChart key={`${item.symbol}-${item.date}`} symbol={item.symbol} date={item.date} title={`${item.symbol} · ${item.date}`} historicalDays={historicalDays} /></div>
    <div className="pl-bar" aria-label="Classification">
      <span className="pl-muted">{structure.is_predefined ? 'Save a custom classification (the system one stays)' : editable ? 'Edit classification' : 'Classification (shared, read only)'}</span>
      {field('Opening', 'opening_type', types.opening_types)}{field('Midday', 'midday_type', types.midday_types)}{field('Closing', 'closing_type', types.closing_types)}
      {(editable || structure.is_predefined) && <button className="pl-save" onClick={() => void save()}>{structure.is_predefined ? 'Save custom' : 'Update'}</button>}
      {message && <span className={message.kind === 'error' ? 'pl-error' : 'pl-ok'} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</span>}
    </div>
  </div>
}

/** Chart Structures (Broad) on the desktop: filter days by Opening / Midday / Closing structure, open one on the KLine chart and classify it. */
export default function ChartStructures({ baseUrl, token, onUnauthorized, active }: Props) {
  const { client, environment, settings } = usePatternsRuntime(baseUrl, token, onUnauthorized, active)
  const [types, setTypes] = useState<StructureTypes>({ opening_types: [], midday_types: [], closing_types: [] })
  const [selOpen, setSelOpen] = useState<string[]>([])
  const [selMid, setSelMid] = useState<string[]>([])
  const [selClose, setSelClose] = useState<string[]>([])
  const [structures, setStructures] = useState<ChartStructureItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<ChartStructureItem | null>(null)
  const [tab, setTab] = useState<'broad' | 'fine'>('broad')

  useEffect(() => { if (active) void client.structureTypes().then(setTypes).catch(e => setError(errorText(e))) }, [active, client])
  const refresh = useCallback(async () => {
    setLoading(true); setError('')
    try { setStructures((await client.listStructures({ opening_types: selOpen, midday_types: selMid, closing_types: selClose })).structures) }
    catch (e) { setError(errorText(e)) } finally { setLoading(false) }
  }, [client, selOpen, selMid, selClose])
  useEffect(() => { if (active) void refresh() }, [active, refresh])

  return <AnalysisProvider value={environment}>
    <div className="pl cs">
      <header className="pl-head"><h2>Chart Structures</h2>
        <div className="pl-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'broad'} onClick={() => setTab('broad')}>Broad</button>
          <button role="tab" aria-selected={tab === 'fine'} onClick={() => setTab('fine')}>Fine</button>
        </div>
      </header>
      {/* Fine stays mounted so a half-built flow survives a look at Broad. */}
      <div hidden={tab !== 'fine'}><FineStructures client={client} settings={settings} active={active && tab === 'fine'} /></div>
      <div hidden={tab === 'fine'}>{open
        ? <DayView client={client} item={open} structures={structures} types={types} historicalDays={settings.historicalDays} onNavigate={setOpen} onClose={() => setOpen(null)} onSaved={() => void refresh()} />
        : <>
          <div className="pl-bar">
            <MultiSelect label="Opening" options={types.opening_types} selected={selOpen} onChange={setSelOpen} />
            <MultiSelect label="Midday" options={types.midday_types} selected={selMid} onChange={setSelMid} />
            <MultiSelect label="Closing" options={types.closing_types} selected={selClose} onChange={setSelClose} />
            <span className="pl-muted">{structures.length} chart{structures.length === 1 ? '' : 's'}</span>
          </div>
          {error && <p className="pl-error" role="alert">{error}</p>}
          {loading ? <p className="pl-muted">Loading…</p> : structures.length === 0 && !error
            ? <p className="pl-muted">No structures found. Run <code>scripts/classify_chart_structures.py</code> to classify more dates.</p>
            : <div className="cs-grid">{structures.map(s => <button key={s.chart_structure_id} className="cs-card" onClick={() => setOpen(s)}>
              <span className="cs-card-head"><strong>{s.symbol}</strong><span className="pl-muted">{s.date}</span></span>
              <span><Badge value={s.opening_type} /><Badge value={s.midday_type} /><Badge value={s.closing_type} /></span>
              <Sparkline client={client} item={s} />
              {!s.can_delete && !s.is_predefined && <span className="pl-muted">Shared</span>}
            </button>)}</div>}
        </>}</div>
    </div>
  </AnalysisProvider>
}

import { useCallback, useEffect, useState } from 'react'
import type { FineDefinition, PatternsClient } from '../patternsClient'
import type { PatternSettings } from './usePatternsRuntime'
import { FineBuilder } from './FineBuilder'
import { FineDefinitions } from './FineDefinitions'
import { FineSearch } from './FineSearch'

type Tab = 'definitions' | 'builder' | 'search'
const TABS: Array<{ id: Tab; label: string }> = [{ id: 'builder', label: 'Builder' }, { id: 'search', label: 'Search' }, { id: 'definitions', label: 'Definitions' }]

/** Fine Structures on the desktop: define structures, build flows of them on a day's charts, and search saved flows. */
export default function FineStructures({ client, settings, active }: { client: PatternsClient; settings: PatternSettings; active: boolean }) {
  const [tab, setTab] = useState<Tab>('builder')
  const [definitions, setDefinitions] = useState<FineDefinition[]>([])
  const [error, setError] = useState('')
  const refresh = useCallback(() => { client.listDefinitions().then(setDefinitions).catch(e => setError(e instanceof Error ? e.message : String(e))) }, [client])
  useEffect(() => { if (active) refresh() }, [active, refresh])
  return <div className="fs">
    <div className="pl-tabs" role="tablist">{TABS.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
    {error && <p className="pl-error" role="alert">{error}</p>}
    {/* Each view stays mounted so a half-built flow or a search survives a tab switch. */}
    <div hidden={tab !== 'builder'}><FineBuilder client={client} definitions={definitions} settings={settings} active={active && tab === 'builder'} /></div>
    <div hidden={tab !== 'search'}><FineSearch client={client} definitions={definitions} settings={settings} active={active && tab === 'search'} /></div>
    <div hidden={tab !== 'definitions'}><FineDefinitions client={client} definitions={definitions} onRefresh={refresh} /></div>
  </div>
}

import { useCallback, useEffect, useState } from 'react'
import PatternNameSelect from '../../../../shared/analysis/PatternNameSelect'
import { readableError } from '../../../../shared/analysis/behavior/types'
import type { DiveRef, DiveSummary } from '../../../../shared/deepdive/types'
import type { PatternsClient } from '../../patternsClient'

interface Props {
  client: PatternsClient
  loading: boolean
  error: string | null
  onOpen: (ref: DiveRef, symbol: string | undefined, ownerId?: string) => void
}

/** The list of deep dives and the form that starts one: a category and a strategy, then the symbol. */
export default function DiveHome({ client, loading, error, onOpen }: Props) {
  const api = client.deepDive
  const [dives, setDives] = useState<DiveSummary[] | null>(null)
  const [categories, setCategories] = useState<string[]>([])
  const [strategies, setStrategies] = useState<string[]>([])
  const [category, setCategory] = useState('')
  const [strategy, setStrategy] = useState('')
  const [symbol, setSymbol] = useState('NIFTY')
  const [failure, setFailure] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [list, c, s] = await Promise.all([api.listDives(), client.listCategories(), client.listStrategies()])
      setDives(list); setCategories(c.categories); setStrategies(s.strategies); setFailure(null)
    } catch (e) { setFailure(readableError(e)) }
  }, [api, client])
  useEffect(() => { void refresh() }, [refresh])

  const createName = (add: (name: string) => Promise<unknown>) => async (name: string) => { await add(name); return name }
  const shown = error ?? failure

  return <div className="dd">
    <section className="dd-start">
      <h3>Start a deep dive</h3>
      <p className="pl-muted">Study one strategy across the days it occurred: mark the days, then tag what each day showed. Pick a category and a strategy (or add new ones).</p>
      <div className="pl-bar">
        <label>Category <PatternNameSelect noun="category" value={category} options={categories} placeholder="— select —" style={{}} onChange={setCategory}
          onCreate={createName(client.addCategory)} /></label>
        <label>Strategy <PatternNameSelect noun="strategy" value={strategy} options={strategies} placeholder="— select —" style={{}} onChange={setStrategy}
          onCreate={createName(client.addStrategy)} /></label>
        <label>Symbol <input list="dd-symbols" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} size={9} /></label>
        <datalist id="dd-symbols"><option value="NIFTY" /><option value="BSESEN" /></datalist>
        <button className="pl-primary" disabled={!category || !strategy || !symbol || loading} onClick={() => onOpen({ category, strategy }, symbol)}>
          {loading ? 'Opening…' : 'Start deep dive'}
        </button>
      </div>
    </section>
    {shown && <p className="pl-error" role="alert">{shown}</p>}
    <section>
      <h3>Your deep dives{dives ? ` (${dives.length})` : ''}</h3>
      {dives === null ? <p className="pl-muted">Loading…</p> : dives.length === 0 ? <p className="pl-muted">No deep dives yet. Start one above.</p> : <table className="dd-table">
        <thead><tr><th>Category</th><th>Strategy</th><th>Days</th><th>Tags</th><th>Needs marking</th><th>From</th><th /></tr></thead>
        <tbody>{dives.map(dive => <tr key={`${dive.owner_id}|${dive.category}|${dive.strategy}`}>
          <td>{dive.category}</td><td>{dive.strategy}</td>
          <td>{dive.days} <span className="pl-muted">({dive.buy_days} buy · {dive.sell_days} sell)</span></td>
          <td>{dive.tags}</td>
          <td>{dive.incomplete_days > 0 ? <span className="dd-warn">{dive.incomplete_days} {dive.incomplete_days === 1 ? 'day' : 'days'}</span> : <span className="pl-muted">—</span>}</td>
          <td>{dive.can_edit ? 'You' : 'Shared with you'}</td>
          <td><button disabled={loading} onClick={() => onOpen({ category: dive.category, strategy: dive.strategy }, undefined, dive.can_edit ? undefined : dive.owner_id)}>Open</button></td>
        </tr>)}</tbody>
      </table>}
    </section>
  </div>
}

import { useCallback, useState } from 'react'
import { readableError } from '../../../../shared/analysis/behavior/types'
import type { Dive, DiveRef } from '../../../../shared/deepdive/types'
import type { PatternsClient } from '../../patternsClient'
import type { PatternSettings } from '../usePatternsRuntime'
import DateMarking from './DateMarking'
import DiveHome from './DiveHome'

interface Props { client: PatternsClient; settings: PatternSettings }

/**
 * The Deep Dive tab of the Pattern Library: the list of deep dives, then one dive. Steps come one per sprint: marking the
 * days now, the in-depth day-by-day analysis and the results next.
 */
export default function DeepDive({ client, settings }: Props) {
  const api = client.deepDive
  const [dive, setDive] = useState<Dive | null>(null)
  const [symbol, setSymbol] = useState('NIFTY')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback(async (ref: DiveRef, startSymbol: string | undefined, ownerId?: string) => {
    setLoading(true); setError(null)
    try {
      const loaded = await api.getDive(ref, ownerId)
      setDive(loaded)
      setSymbol(startSymbol ?? loaded.setups.slice(-1)[0]?.symbol ?? 'NIFTY')
    } catch (e) { setError(readableError(e)) } finally { setLoading(false) }
  }, [api])

  if (!dive) return <DiveHome client={client} loading={loading} error={error} onOpen={(ref, start, owner) => void open(ref, start, owner)} />
  return <div className="dd">
    <div className="pl-bar dd-title">
      <button onClick={() => setDive(null)}>← All deep dives</button>
      <h3>{dive.category} / {dive.strategy}</h3>
      <span className="pl-muted">Step 1 · Mark the days</span>
    </div>
    <DateMarking api={api} dive={dive} setDive={update => setDive(current => (current ? update(current) : current))} symbol={symbol} onSymbol={setSymbol} settings={settings} />
  </div>
}

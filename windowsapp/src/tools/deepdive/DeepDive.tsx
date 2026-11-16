import { useCallback, useState } from 'react'
import { readableError } from '../../../../shared/analysis/behavior/types'
import type { Dive, DiveRef, DiveSetup } from '../../../../shared/deepdive/types'
import type { PatternsClient } from '../../patternsClient'
import type { PatternSettings } from '../usePatternsRuntime'
import DateMarking from './DateMarking'
import DiveHome from './DiveHome'
import InDepth from './InDepth'
import Results from './Results'

interface Props { client: PatternsClient; settings: PatternSettings }

/**
 * The Deep Dive tab of the Pattern Library: the list of deep dives, then one dive with its steps: mark the days, then the
 * in-depth day-by-day analysis, then the results (frequency percentages).
 */
export default function DeepDive({ client, settings }: Props) {
  const api = client.deepDive
  const [dive, setDive] = useState<Dive | null>(null)
  const [symbol, setSymbol] = useState('NIFTY')
  const [step, setStep] = useState<'mark' | 'depth' | 'results'>('mark')
  const [focus, setFocus] = useState<DiveSetup | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback(async (ref: DiveRef, startSymbol: string | undefined, ownerId?: string) => {
    setLoading(true); setError(null)
    try {
      const loaded = await api.getDive(ref, ownerId)
      setDive(loaded)
      setStep('mark'); setFocus(null)
      setSymbol(startSymbol ?? loaded.setups.slice(-1)[0]?.symbol ?? 'NIFTY')
    } catch (e) { setError(readableError(e)) } finally { setLoading(false) }
  }, [api])

  if (!dive) return <DiveHome client={client} loading={loading} error={error} onOpen={(ref, start, owner) => void open(ref, start, owner)} />
  return <div className="dd">
    <div className="pl-bar dd-title">
      <button onClick={() => setDive(null)}>← All deep dives</button>
      <h3>{dive.category} / {dive.strategy}</h3>
      <div className="pl-tabs" role="tablist" aria-label="Deep dive steps">
        <button role="tab" aria-selected={step === 'mark'} onClick={() => setStep('mark')}>1 · Mark days ({dive.setups.length})</button>
        <button role="tab" aria-selected={step === 'depth'} onClick={() => { setFocus(null); setStep('depth') }}>2 · In-depth{dive.incomplete_days ? ` (${dive.incomplete_days} to mark)` : ''}</button>
        <button role="tab" aria-selected={step === 'results'} onClick={() => setStep('results')}>3 · Results</button>
      </div>
    </div>
    {step === 'mark' && <DateMarking api={api} dive={dive} setDive={update => setDive(current => (current ? update(current) : current))} symbol={symbol} onSymbol={setSymbol} settings={settings} />}
    {step === 'depth' && <InDepth client={client} api={api} dive={dive} setDive={update => setDive(current => (current ? update(current) : current))} settings={settings} onGoMark={() => setStep('mark')} focus={focus} />}
    {step === 'results' && <Results api={api} dive={dive} onOpenDay={day => { setFocus(day); setStep('depth') }} />}
  </div>
}

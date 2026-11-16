import { useCallback, useState } from 'react'
import { readableError } from '../../analysis/behavior/types'
import type { Dive, DiveRef, DiveSetup } from '../types'
import DateMarking from './DateMarking'
import DiveHome from './DiveHome'
import { DeepDiveHostProvider, useDeepDiveHost, type DeepDiveHost } from './host'
import InDepth from './InDepth'
import Results from './Results'
import './deepdive.css'

/**
 * The Deep Dive of the Pattern Library: the list of deep dives, then one dive with its steps: mark the days, then the
 * in-depth day-by-day analysis, then the results (frequency percentages). The same screens run in the Windows app and on the
 * website; `host` is what differs (API transport, names, strike lookup, settings, chart).
 */
export default function DeepDive({ host }: { host: DeepDiveHost }) {
  return <DeepDiveHostProvider host={host}><DeepDiveSteps /></DeepDiveHostProvider>
}

function DeepDiveSteps() {
  const { api } = useDeepDiveHost()
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

  if (!dive) return <DiveHome loading={loading} error={error} onOpen={(ref, start, owner) => void open(ref, start, owner)} />
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
    {step === 'mark' && <DateMarking dive={dive} setDive={update => setDive(current => (current ? update(current) : current))} symbol={symbol} onSymbol={setSymbol} />}
    {step === 'depth' && <InDepth dive={dive} setDive={update => setDive(current => (current ? update(current) : current))} onGoMark={() => setStep('mark')} focus={focus} />}
    {step === 'results' && <Results dive={dive} onOpenDay={day => { setFocus(day); setStep('depth') }} />}
  </div>
}

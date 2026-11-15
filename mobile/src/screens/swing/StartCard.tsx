import { useEffect, useState } from 'react'
import { describeSwingError } from './swingErrors'
import type { StartBody, SwingApi } from './swingApi'
import type { Broker, SwingMode } from './swingTypes'

const BROKERS: Array<{ id: Broker; label: string }> = [{ id: 'kite', label: 'Kite' }, { id: 'kotak', label: 'Kotak' }]

/**
 * Start a swing portfolio. Paper: a starting capital. Real: a share of the broker account and the broker; the broker's
 * session must already be connected (that is done on the website or desktop, not here).
 */
export function StartCard({ api, mode, broker, onBroker, onStarted, stopped }: {
  api: SwingApi; mode: SwingMode; broker: Broker; onBroker: (broker: Broker) => void
  onStarted: (snapshot: Awaited<ReturnType<SwingApi['start']>>) => void; stopped?: boolean
}) {
  const [capital, setCapital] = useState('100000')
  const [allocation, setAllocation] = useState('100')
  const [loss, setLoss] = useState('')
  const [paperBroker, setPaperBroker] = useState<Broker>('kite')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState<boolean | null>(null)

  useEffect(() => {
    if (mode !== 'real') { setConnected(null); return }
    let cancelled = false
    setConnected(null)
    api.brokerStatus(broker).then(status => { if (!cancelled) setConnected(status.authenticated) }).catch(() => { if (!cancelled) setConnected(false) })
    return () => { cancelled = true }
  }, [api, mode, broker])

  const capitalValue = Number(capital)
  const allocationValue = Number(allocation)
  const lossValue = loss.trim() === '' ? undefined : Number(loss)
  const invalid =
    (mode === 'paper' && !(capitalValue >= 1)) ||
    (mode === 'real' && !(allocationValue > 0 && allocationValue <= 100)) ||
    (lossValue !== undefined && !(lossValue > 0 && lossValue <= 100))

  async function start() {
    if (busy || invalid) return
    setBusy(true); setError(null)
    const body: StartBody = {
      mode, execution_broker: broker, paper_broker: mode === 'paper' ? paperBroker : 'kite',
      allocation_pct: mode === 'real' ? allocationValue / 100 : 1,
      // The server needs a capital figure; a real portfolio sizes from the broker account, not from this number.
      capital: mode === 'paper' ? capitalValue : 100000,
      ...(lossValue !== undefined ? { loss_limit_pct: lossValue / 100 } : {}),
    }
    try { onStarted(await api.start(body)) } catch (caught) { setError(describeSwingError(caught)); setBusy(false) }
  }

  return (
    <div className="swing-start card" aria-label={`Start a ${mode} portfolio`}>
      <h3>{stopped ? 'Start this portfolio again' : `Start a ${mode} swing portfolio`}</h3>
      <p className="muted">Hold shares, options and futures across days in one portfolio. Closing the app never stops it.</p>
      <div className="swing-start-grid">
        {mode === 'paper' ? (
          <>
            <label className="field">Starting capital ₹
              <input type="number" inputMode="decimal" min="1" value={capital} onChange={event => setCapital(event.target.value)} />
            </label>
            <div className="field" role="group" aria-label="Prices from">
              <span className="field-label">Prices and futures model of</span>
              <div className="chips">{BROKERS.map(item => <button key={item.id} type="button" className="chip" aria-pressed={paperBroker === item.id} onClick={() => setPaperBroker(item.id)}>{item.label}</button>)}</div>
            </div>
          </>
        ) : (
          <>
            <label className="field">Share of the broker account %
              <input type="number" inputMode="decimal" min="0.01" max="100" value={allocation} onChange={event => setAllocation(event.target.value)} />
            </label>
            <div className="field" role="group" aria-label="Broker">
              <span className="field-label">Broker</span>
              <div className="chips">{BROKERS.map(item => <button key={item.id} type="button" className="chip" aria-pressed={broker === item.id} onClick={() => onBroker(item.id)}>{item.label}</button>)}</div>
            </div>
          </>
        )}
        <label className="field">Loss limit % (optional)
          <input type="number" inputMode="decimal" min="0.01" max="100" placeholder="None" value={loss} onChange={event => setLoss(event.target.value)} />
        </label>
      </div>
      {mode === 'real' && connected === false && <div className="form-error" role="alert">The {broker === 'kite' ? 'Kite' : 'Kotak'} session is not connected. Connect it on the website (Settings → Admin) or the desktop app, then try again.</div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <button type="button" className={`btn btn-primary${mode === 'real' ? ' btn-real' : ''}`} disabled={busy || invalid || (mode === 'real' && connected !== true)} onClick={() => void start()}>
        {busy ? 'Starting…' : mode === 'real' ? 'Start REAL portfolio' : 'Start portfolio'}
      </button>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { Sheet } from '../../shell/Sheet'
import { useToast } from '../../shell/Toast'
import { SymbolSheet } from '../browse/SymbolSheet'
import type { Instrument as CatalogueItem } from '../browse/browseModel'
import { describeSwingError, isUncertainWrite } from './swingErrors'
import type { SwingApi } from './swingApi'
import { contractName, price as priceText, rupees, shortDate } from './swingFormat'
import {
  allowedTypes, estimatedValue, findContract, fixType, heldPosition, instructionKey, intentLabel, isExit, needsPreview, orderBody,
  orderQuantity, outstandingExit, previewBody, problems, RequestIdentity, snapPrice, type Draft,
} from './orderTicket'
import type { Instrument, ListedContract, OrderPreview, Snapshot } from './swingTypes'

export interface TicketPreset {
  draft: Draft
  /** Exit: fill in everything that is free to sell once the lot size is known. */
  exitAll?: boolean
  /** The price the contract last traded at, offered as "Use last price". */
  lastPrice?: number | null
}

const KIND_LABEL: Record<Instrument, string> = { equity: 'Shares', options: 'Options', futures: 'Futures' }
const TYPE_LABEL = { LIMIT: 'Limit', TARGET: 'Target (trigger)', STOPLOSS: 'Stoploss (trigger)' } as const

/**
 * The order ticket: build an order, see what it will cost, review it in a summary, confirm. Nothing is sent until the
 * Confirm button of the summary; the same instructions sent again keep one request id, so a repeat can never place twice.
 */
export function TicketSheet({ api, snapshot, catalogue, preset, onClose, onApply }: {
  api: SwingApi; snapshot: Snapshot; catalogue: CatalogueItem[]; preset: TicketPreset; onClose: () => void; onApply: (snapshot: Snapshot) => void
}) {
  const portfolio = snapshot.portfolio!
  const real = portfolio.mode === 'real'
  const toast = useToast()
  const [draft, setDraftState] = useState<Draft>(() => preset.draft)
  const [contracts, setContracts] = useState<{ list: ListedContract[]; loading: boolean; error: string | null; futuresEnabled: boolean }>({ list: [], loading: false, error: null, futuresEnabled: true })
  const [preview, setPreview] = useState<{ key: string; value: OrderPreview | null; error: string | null; loading: boolean }>({ key: '', value: null, error: null, loading: false })
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [picking, setPicking] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const identity = useRef(new RequestIdentity())
  const exitAllPending = useRef(Boolean(preset.exitAll))
  const provider = portfolio.execution_broker ?? portfolio.paper_broker ?? 'kite'

  const setDraft = (patch: Partial<Draft>) => setDraftState(current => fixType({ ...current, ...patch }, snapshot.positions))

  const item = catalogue.find(entry => entry.symbol === draft.symbol)
  const isIndex = item?.chart_type === 'index'
  const derivativesOk = item ? item.option_eligible !== false : true
  const kinds: Instrument[] = isIndex ? ['options', 'futures'] : derivativesOk ? ['equity', 'options', 'futures'] : ['equity']

  // Contracts of the chosen symbol (options or futures).
  useEffect(() => {
    if (draft.instrument === 'equity') { setContracts({ list: [], loading: false, error: null, futuresEnabled: true }); return }
    const controller = new AbortController()
    setContracts({ list: [], loading: true, error: null, futuresEnabled: true })
    api.contracts(draft.symbol, draft.instrument, provider, controller.signal)
      .then(result => {
        const list = result.contracts ?? []
        setContracts({ list, loading: false, error: list.length ? null : 'No listed contracts for this symbol.', futuresEnabled: result.execution_enabled !== false })
        setDraftState(current => {
          if (current.symbol !== draft.symbol || current.instrument !== draft.instrument) return current
          if (current.expiry && list.some(contract => contract.expiry === current.expiry)) return current
          return { ...current, expiry: list[0]?.expiry ?? '', strike: current.instrument === 'options' ? '' : current.strike }
        })
      })
      .catch(error => { if (!controller.signal.aborted) setContracts({ list: [], loading: false, error: describeSwingError(error), futuresEnabled: true }) })
    return () => controller.abort()
  }, [api, draft.symbol, draft.instrument, provider])

  const contract = findContract(contracts.list, draft)
  const expiries = useMemo(() => [...new Set(contracts.list.map(entry => entry.expiry))].sort(), [contracts.list])
  const strikes = useMemo(
    () => contracts.list.filter(entry => entry.expiry === draft.expiry && entry.right === draft.right && entry.strike != null).map(entry => entry.strike as number).sort((a, b) => a - b),
    [contracts.list, draft.expiry, draft.right],
  )

  const held = heldPosition(snapshot.positions, draft)
  const exit = isExit(draft, snapshot.positions)
  const previewNeeded = needsPreview(draft, snapshot.positions)

  // Exit everything that is free, once the lot size is known.
  useEffect(() => {
    if (!exitAllPending.current || !held) return
    const lot = draft.instrument === 'equity' ? 1 : contract?.lot_size
    if (!lot) return
    exitAllPending.current = false
    const free = held.quantity - outstandingExit(snapshot.open_orders, draft, held)
    setDraftState(current => ({ ...current, quantity: String(Math.max(1, Math.floor(free / lot))) }))
  }, [held, contract, draft, snapshot.open_orders])

  // The margin / size estimate the server wants for every future and every capital-% entry.
  const body = useMemo(() => (previewNeeded && Number(draft.price) > 0 ? previewBody(draft, portfolio, contract) : null), [previewNeeded, draft, portfolio, contract])
  const bodyReady = body !== null && (draft.instrument !== 'equity' ? Boolean(contract) : true) &&
    (draft.sizing === 'capital_pct' ? Number(draft.capitalPct) > 0 && Number(draft.capitalPct) <= 100 : Number(draft.quantity) > 0)
  const previewKey = bodyReady ? JSON.stringify(body) : ''
  useEffect(() => {
    if (!previewKey) { setPreview({ key: '', value: null, error: null, loading: false }); return }
    setPreview({ key: '', value: null, error: null, loading: true })
    const timer = setTimeout(() => {
      api.orderPreview(portfolio.session_id, JSON.parse(previewKey))
        .then(value => setPreview({ key: previewKey, value, error: null, loading: false }))
        .catch(error => setPreview({ key: '', value: null, error: describeSwingError(error), loading: false }))
    }, 350)
    return () => clearTimeout(timer)
  }, [api, portfolio.session_id, previewKey])
  const activePreview = preview.key === previewKey && previewKey ? preview.value : null

  const found = problems(draft, { portfolio, positions: snapshot.positions, openOrders: snapshot.open_orders, contract, preview: activePreview })
  if (draft.instrument === 'futures' && !contracts.futuresEnabled && !found.includes('Futures orders are not enabled on this server.')) found.push('Futures orders are not enabled on this server.')
  const units = orderQuantity(draft, contract, activePreview)
  const value = estimatedValue(draft, contract, activePreview)
  const tick = contract?.tick_size ?? 0.05
  const lot = draft.instrument === 'equity' ? 1 : contract?.lot_size ?? 1

  function stepPrice(direction: 1 | -1) {
    const base = Number(draft.price) > 0 ? Number(draft.price) : preset.lastPrice ?? 0
    const next = Math.max(tick, Math.round((base + direction * tick) / tick) * tick)
    setDraft({ price: String(Number(next.toFixed(8))) })
  }

  async function send() {
    if (sending || found.length) return
    setSending(true); setSendError(null)
    const requestId = identity.current.idFor(instructionKey(draft, activePreview))
    try {
      onApply(await api.placeOrder(portfolio.session_id, orderBody(draft, contract, activePreview, requestId)))
      identity.current.done()
      toast(real ? 'Real order sent' : 'Paper order placed')
      onClose()
    } catch (error) {
      setUncertain(isUncertainWrite(error))
      setSendError(describeSwingError(error))
      setSending(false)
    }
  }

  if (picking) {
    return (
      <SymbolSheet instruments={catalogue.length ? catalogue : [{ symbol: draft.symbol, display_name: draft.symbol }]} current={draft.symbol} recents={[]}
        onPick={symbol => {
          const next = catalogue.find(entry => entry.symbol === symbol)
          const kind: Instrument = next?.chart_type === 'index' ? 'options' : 'equity'
          setDraftState(current => fixType({ ...current, symbol, instrument: kind, expiry: '', strike: '', price: '', quantity: '1' }, snapshot.positions))
          setPicking(false)
        }}
        onClose={() => setPicking(false)} />
    )
  }

  const label = contractName({ symbol: draft.symbol, instrument_type: draft.instrument, expiry: draft.expiry, strike: Number(draft.strike) || null, right: draft.right })

  if (step === 'review') {
    return (
      <Sheet title="Review order" onClose={() => (sending ? undefined : setStep('edit'))}>
        <div className={`swing-banner swing-banner-${portfolio.mode}`} role="status">{real ? 'REAL MONEY order' : 'PAPER order (practice)'}</div>
        <dl className="swing-facts" aria-label="Order summary">
          <dt>Instrument</dt><dd>{label}</dd>
          <dt>Action</dt><dd className={draft.side === 'BUY' ? 'pos' : 'neg'}>{intentLabel(draft, snapshot.positions)}</dd>
          <dt>Quantity</dt><dd>{units}{draft.instrument !== 'equity' ? ` (${units / lot} lot${units / lot === 1 ? '' : 's'} of ${lot})` : ''}</dd>
          <dt>{draft.type === 'LIMIT' ? 'Limit price' : 'Trigger price'}</dt><dd>{priceText(Number(draft.price))} <small>{TYPE_LABEL[draft.type]}</small></dd>
          {value !== null && <><dt>Approx. value</dt><dd>{rupees(value)}</dd></>}
          {activePreview?.margin != null && <><dt>Margin</dt><dd>{rupees(activePreview.margin)}</dd></>}
          {activePreview && <><dt>Fees (est.)</dt><dd>{rupees(activePreview.fees)}</dd><dt>Funds needed</dt><dd>{rupees(activePreview.required_funds)}</dd></>}
        </dl>
        <p className="muted">No market orders: this is sent at the price above. The portfolio decides at the exchange whether and when it fills.</p>
        {uncertain && <div className="form-error" role="alert">Not sure whether this went through. Refresh and look first. Pressing Confirm again sends the same order, which cannot be placed twice.</div>}
        {sendError && <div className="form-error" role="alert">{sendError}</div>}
        <div className="sheet-actions">
          <button type="button" className="btn" disabled={sending} onClick={() => setStep('edit')}>Back</button>
          <button type="button" className={`btn btn-primary${real ? ' btn-real' : ''}`} disabled={sending || found.length > 0} onClick={() => void send()}>
            {sending ? 'Sending…' : real ? 'Place REAL order' : 'Place paper order'}
          </button>
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet title="New order" onClose={onClose}>
      <div className={`swing-banner swing-banner-${portfolio.mode}`} role="status">{real ? 'REAL MONEY' : 'PAPER (practice)'}</div>
      <div className="field">
        <span className="field-label">Symbol</span>
        <button type="button" className="btn swing-symbol" onClick={() => setPicking(true)} aria-label={`Symbol: ${draft.symbol}`}>{item?.display_name ?? draft.symbol} <small>{draft.symbol}</small></button>
      </div>
      <div className="field" role="group" aria-label="Instrument">
        <span className="field-label">Instrument</span>
        <div className="chips">{kinds.map(kind => <button key={kind} type="button" className="chip" aria-pressed={draft.instrument === kind} onClick={() => setDraft({ instrument: kind, expiry: '', strike: '', price: '' })}>{KIND_LABEL[kind]}</button>)}</div>
      </div>
      {draft.instrument !== 'equity' && (
        <>
          {contracts.loading && <p className="muted" role="status">Loading contracts…</p>}
          {contracts.error && <div className="form-error" role="alert">{contracts.error}</div>}
          {expiries.length > 0 && (
            <div className="field" role="group" aria-label="Expiry">
              <span className="field-label">Expiry</span>
              <div className="chips">{expiries.slice(0, 6).map(expiry => <button key={expiry} type="button" className="chip" aria-pressed={draft.expiry === expiry} onClick={() => setDraft({ expiry, strike: '' })}>{shortDate(expiry)}</button>)}</div>
            </div>
          )}
          {draft.instrument === 'options' && expiries.length > 0 && (
            <div className="field-row">
              <div className="field" role="group" aria-label="Right">
                <span className="field-label">Call or put</span>
                <div className="chips">{(['CE', 'PE'] as const).map(right => <button key={right} type="button" className="chip" aria-pressed={draft.right === right} onClick={() => setDraft({ right, strike: '' })}>{right === 'CE' ? 'Call (CE)' : 'Put (PE)'}</button>)}</div>
              </div>
              <label className="field">Strike
                <select value={draft.strike} onChange={event => setDraft({ strike: event.target.value })} aria-label="Strike">
                  <option value="">Choose…</option>
                  {strikes.map(strike => <option key={strike} value={String(strike)}>{strike}</option>)}
                </select>
              </label>
            </div>
          )}
        </>
      )}
      <div className="field" role="group" aria-label="Side">
        <span className="field-label">{draft.instrument === 'futures' ? 'Direction' : 'Buy or sell'}</span>
        <div className="chips">
          {(['BUY', 'SELL'] as const).map(side => (
            <button key={side} type="button" className="chip" aria-pressed={draft.side === side} onClick={() => setDraft({ side })}>
              {draft.instrument === 'futures' ? (side === 'BUY' ? 'Buy (long / cover)' : 'Sell (short / exit)') : side === 'BUY' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>
        <small className="muted">{intentLabel(draft, snapshot.positions)}{held ? ` · you hold ${held.quantity}` : ''}</small>
      </div>
      <div className="field" role="group" aria-label="Order type">
        <span className="field-label">Order type</span>
        <div className="chips">{allowedTypes(exit).map(type => <button key={type} type="button" className="chip" aria-pressed={draft.type === type} onClick={() => setDraft({ type })}>{TYPE_LABEL[type]}</button>)}</div>
        <small className="muted">{exit ? 'Limit sells at that price or better; stoploss sells when the price falls to the trigger.' : 'Limit buys at that price or better; target buys when the price rises to the trigger.'}</small>
      </div>
      <div className="field">
        <span className="field-label">{draft.type === 'LIMIT' ? 'Limit price' : 'Trigger price'} (₹)</span>
        <div className="swing-stepper">
          <button type="button" className="btn" aria-label="Lower the price" onClick={() => stepPrice(-1)}>−</button>
          <input type="number" inputMode="decimal" aria-label="Price" step={tick} value={draft.price} onChange={event => setDraft({ price: event.target.value })} onBlur={() => setDraft({ price: snapPrice(draft, contract) })} />
          <button type="button" className="btn" aria-label="Raise the price" onClick={() => stepPrice(1)}>+</button>
        </div>
        {preset.lastPrice != null && preset.lastPrice > 0 && <button type="button" className="btn btn-link" onClick={() => setDraft({ price: snapPrice({ ...draft, price: String(preset.lastPrice) }, contract) })}>Use last price {priceText(preset.lastPrice)}</button>}
      </div>
      {!exit && (
        <div className="field" role="group" aria-label="Sizing">
          <span className="field-label">Size by</span>
          <div className="chips">
            <button type="button" className="chip" aria-pressed={draft.sizing === 'quantity'} onClick={() => setDraft({ sizing: 'quantity' })}>{draft.instrument === 'equity' ? 'Shares' : 'Lots'}</button>
            <button type="button" className="chip" aria-pressed={draft.sizing === 'capital_pct'} onClick={() => setDraft({ sizing: 'capital_pct' })}>% of capital</button>
          </div>
        </div>
      )}
      {draft.sizing === 'capital_pct' && !exit ? (
        <label className="field">Share of the portfolio capital %
          <input type="number" inputMode="decimal" min="0.1" max="100" aria-label="Capital percent" value={draft.capitalPct} onChange={event => setDraft({ capitalPct: event.target.value })} />
          {activePreview && <small className="muted">≈ {activePreview.quantity} {draft.instrument === 'equity' ? 'shares' : `units (${activePreview.quantity / (activePreview.lot_size || 1)} lots)`}</small>}
        </label>
      ) : (
        <label className="field">{draft.instrument === 'equity' ? 'Shares' : `Lots${contract ? ` (1 lot = ${contract.lot_size})` : ''}`}
          <input type="number" inputMode="numeric" min="1" step="1" aria-label="Quantity" value={draft.quantity} onChange={event => setDraft({ quantity: event.target.value })} />
        </label>
      )}
      {previewNeeded && (
        <div className="swing-estimate" role="status" aria-label="Estimate">
          {preview.loading && <span>Estimating…</span>}
          {preview.error && <span className="form-error">{preview.error}</span>}
          {activePreview && <span>Margin {rupees(activePreview.margin ?? activePreview.required_funds)} · Fees {rupees(activePreview.fees)} · Needs {rupees(activePreview.required_funds)}</span>}
        </div>
      )}
      {found.length > 0 && <ul className="swing-problems" role="status" aria-label="Fix before reviewing">{found.map(text => <li key={text}>{text}</li>)}</ul>}
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={found.length > 0} onClick={() => { setSendError(null); setStep('review') }}>Review order</button>
      </div>
    </Sheet>
  )
}

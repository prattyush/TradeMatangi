import { useCallback, useEffect, useState } from 'react'
import { useAppLock } from '../../app/AppLock'
import { useServices } from '../../app/AppContext'
import { useLoad } from '../../app/useLoad'
import { useToast } from '../../shell/Toast'
import { EmptyState, ErrorState, NotAvailable, Spinner } from '../../shell/States'
import type { Instrument as CatalogueItem } from '../browse/browseModel'
import { newDraft } from './orderTicket'
import { OrderSheet } from './OrderSheet'
import { PortfolioSheet } from './PortfolioSheet'
import { PositionSheet, type PositionAction } from './PositionSheet'
import { PositionChart } from './PositionChart'
import { presetFor } from './positionActions'
import { StartCard } from './StartCard'
import { TicketSheet, type TicketPreset } from './TicketSheet'
import { ageText, contractName, orderSummary, price, quoteNote, rupees, sideWord, signedPct, signedRupees, tone } from './swingFormat'
import type { Broker, PendingOrder, Position, Snapshot, SwingMode } from './swingTypes'
import { useSwingPortfolio } from './useSwingPortfolio'
import './swing.css'

/** After the phone's lock confirmed it is the owner, the real portfolio stays open for this long. */
export const REAL_UNLOCK_MS = 5 * 60_000

const FALLBACK_CATALOGUE: CatalogueItem[] = [{ symbol: 'NIFTY', display_name: 'NIFTY 50', chart_type: 'index', option_eligible: true }]
const positionKey = (position: Position) => `${position.session_id}:${contractName(position)}`

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(timer) }, [everyMs])
  return now
}

type Sheet =
  | { kind: 'ticket'; preset: TicketPreset }
  | { kind: 'position'; key: string }
  | { kind: 'order'; id: string }
  | { kind: 'portfolio' }
  | { kind: 'chart'; key: string }

/**
 * Swing trading from the phone: the Swing portfolio of the chosen account (paper, or real when the account may and the
 * App lock is on), its positions and pending orders, and the order ticket. The server stays the only authority: every
 * number here is the snapshot it sent, and every action is its swing route.
 */
export function SwingScreen() {
  const { client, appLock } = useServices()
  const lock = useAppLock()
  const toast = useToast()
  const [mode, setMode] = useState<SwingMode>('paper')
  const [broker, setBroker] = useState<Broker>('kite')
  const [realUntil, setRealUntil] = useState(0)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [tab, setTab] = useState<'positions' | 'orders'>('positions')
  const now = useNow(5_000)

  const realOpen = mode === 'paper' || (lock.enabled && now < realUntil)
  const state = useSwingPortfolio({ mode, broker, enabled: realOpen })
  const { api, snapshot } = state
  const catalogue = useLoad(async signal => (await client.get<{ instruments: CatalogueItem[] }>('/api/desktop/v1/catalogue', undefined, { signal })).instruments, [client])
  const instruments = catalogue.data ?? FALLBACK_CATALOGUE

  // The account's own broker choice is the default for real.
  useEffect(() => {
    const controller = new AbortController()
    client.get<{ real_execution_broker?: string }>('/api/desktop/v1/trading/settings/current', undefined, { signal: controller.signal, retries: 0 })
      .then(settings => { if (settings.real_execution_broker === 'kotak' || settings.real_execution_broker === 'kite') setBroker(settings.real_execution_broker) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [client])

  const confirmOwner = useCallback(async (): Promise<boolean> => {
    const result = await appLock.authenticate('Confirm it is you to trade real money')
    if (result === 'ok') { setRealUntil(Date.now() + REAL_UNLOCK_MS); return true }
    if (result === 'unavailable') toast('Set a screen lock or fingerprint on the phone first')
    return false
  }, [appLock, toast])

  async function chooseMode(next: SwingMode) {
    if (next === mode) return
    setSheet(null)
    if (next === 'paper') { setMode('paper'); return }
    if (!lock.enabled) { setMode('real'); return } // the card below explains how to turn the lock on
    if (await confirmOwner()) setMode('real')
  }

  const portfolio = snapshot?.portfolio ?? null
  const positions = (snapshot?.positions ?? []).filter(position => position.quantity > 0)
  const orders = snapshot?.open_orders ?? []
  const position = sheet && (sheet.kind === 'position' || sheet.kind === 'chart') ? positions.find(item => positionKey(item) === sheet.key) : undefined
  const order = sheet?.kind === 'order' ? orders.find(item => item.order_id === sheet.id) : undefined

  function newOrder() {
    // A share to begin with (an index only trades through options and futures).
    const instrument = instruments.find(item => item.symbol === 'HDFCBANK') ?? instruments.find(item => item.chart_type !== 'index') ?? instruments[0]
    const symbol = instrument?.symbol ?? 'HDFCBANK'
    setSheet({ kind: 'ticket', preset: { draft: newDraft(symbol, instrument?.chart_type === 'index' ? 'options' : 'equity') } })
  }

  const seg = (id: SwingMode, label: string) => (
    <button key={id} type="button" aria-pressed={mode === id} onClick={() => void chooseMode(id)}>{label}</button>
  )

  let body
  if (mode === 'real' && !lock.enabled) {
    body = (
      <EmptyState title="Turn on the App lock to trade real money">
        Real swing trading needs the phone's own lock, so nobody can open the app and trade. Switch it on in More → App lock, then come back.
      </EmptyState>
    )
  } else if (mode === 'real' && !realOpen) {
    body = (
      <EmptyState title="Confirm it is you">
        <button type="button" className="btn btn-primary btn-real" onClick={() => void confirmOwner()}>Unlock real swing</button>
      </EmptyState>
    )
  } else if (state.status === 'unavailable') {
    body = state.error && !/not available on this server/i.test(state.error) ? <EmptyState title={state.error} /> : <NotAvailable what="Swing trading" />
  } else if (state.status === 'error' && !snapshot) {
    body = <ErrorState message={state.error ?? 'Could not load the portfolio.'} onRetry={() => void state.refresh()} />
  } else if (state.status === 'loading' && !snapshot) {
    body = <div className="swing-center"><Spinner label="Loading the portfolio" /></div>
  } else if (!portfolio || portfolio.state === 'ended' || portfolio.state === 'stopped') {
    body = (
      <div className="swing-center">
        {portfolio?.state === 'ended' && <p className="muted" role="status">The last portfolio was closed. P&L {signedRupees(snapshot?.pnl ?? null)}.</p>}
        <StartCard api={api} mode={mode} broker={broker} onBroker={setBroker} stopped={portfolio?.state === 'stopped'} onStarted={value => { state.apply(value); toast(mode === 'real' ? 'Real portfolio started' : 'Portfolio started') }} />
      </div>
    )
  } else {
    body = (
      <>
        <SummaryStrip snapshot={snapshot!} />
        {state.streamNotice && <div className="swing-notice" role="status">{state.streamNotice}</div>}
        <div className="swing-tabs">
          <div className="chips" role="group" aria-label="Show">
            <button type="button" className="chip" aria-pressed={tab === 'positions'} onClick={() => setTab('positions')}>Positions ({positions.length})</button>
            <button type="button" className="chip" aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}>Orders ({orders.length})</button>
          </div>
          <span className="grow" />
          <button type="button" className={`btn btn-primary${portfolio.mode === 'real' ? ' btn-real' : ''}`} disabled={portfolio.state !== 'running'} onClick={newOrder}>New order</button>
        </div>
        <div className="swing-list" role="list" aria-label={tab === 'positions' ? 'Positions' : 'Pending orders'}>
          {tab === 'positions' ? (
            positions.length === 0
              ? <EmptyState title="No open positions">Tap New order to enter one.</EmptyState>
              : positions.map(item => <PositionRow key={positionKey(item)} position={item} onOpen={() => setSheet({ kind: 'position', key: positionKey(item) })} />)
          ) : (
            orders.length === 0
              ? <EmptyState title="No pending orders" />
              : orders.map(item => <OrderRow key={item.order_id} order={item} onOpen={() => setSheet({ kind: 'order', id: item.order_id })} />)
          )}
        </div>
      </>
    )
  }

  return (
    <section className="screen swing" aria-label="Swing">
      <header className="screen-title swing-bar">
        <h2>Swing</h2>
        <div className="segmented" role="group" aria-label="Account">
          {seg('paper', 'Paper')}
          {lock.supported !== false || mode === 'real' ? seg('real', 'Real') : null}
        </div>
        <span className={`badge badge-${mode}`}>{mode === 'real' ? 'REAL' : 'PAPER'}</span>
        <span className="grow" />
        {portfolio && portfolio.state !== 'ended' && realOpen && (
          <span className={`swing-live ${state.connected ? 'on' : ''}`} role="status">{state.connected ? 'Live' : 'Reconnecting'} · {ageText(state.updatedAt, now)}</span>
        )}
        <button type="button" className="btn btn-link" onClick={() => void state.refresh()} aria-label="Refresh">Refresh</button>
        {portfolio && portfolio.state !== 'ended' && realOpen && <button type="button" className="btn btn-link" onClick={() => setSheet({ kind: 'portfolio' })}>Manage</button>}
      </header>
      <div className="swing-body">{body}</div>

      {sheet?.kind === 'ticket' && snapshot && <TicketSheet api={api} snapshot={snapshot} catalogue={instruments} preset={sheet.preset} onClose={() => setSheet(null)} onApply={state.apply} />}
      {sheet?.kind === 'position' && snapshot && position && (
        <PositionSheet snapshot={snapshot} position={position} onClose={() => setSheet(null)} onChart={() => setSheet({ kind: 'chart', key: sheet.key })}
          onAction={(action: PositionAction) => setSheet({ kind: 'ticket', preset: presetFor(position, action) })} />
      )}
      {sheet?.kind === 'chart' && snapshot && position && <PositionChart api={api} snapshot={snapshot} position={position} onClose={() => setSheet({ kind: 'position', key: sheet.key })} />}
      {sheet?.kind === 'order' && snapshot && order && <OrderSheet api={api} snapshot={snapshot} order={order} onClose={() => setSheet(null)} onApply={state.apply} />}
      {sheet?.kind === 'portfolio' && snapshot && portfolio && <PortfolioSheet api={api} snapshot={snapshot} onApply={state.apply} onClose={() => setSheet(null)} confirmReal={confirmOwner} />}
    </section>
  )
}

function SummaryStrip({ snapshot }: { snapshot: Snapshot }) {
  const portfolio = snapshot.portfolio!
  const flags: string[] = []
  if (portfolio.entries_paused) flags.push('Entries paused')
  if (portfolio.guardrail_ban) flags.push('Loss limit reached')
  if (portfolio.state === 'closing') flags.push('Closing…')
  if (snapshot.funding_status && snapshot.funding_status.entries_allowed === false) flags.push('Funds short: entries blocked')
  if (snapshot.reconciliation_pending?.length) flags.push('Reconciling with the broker')
  if (snapshot.valuation_status && snapshot.valuation_status !== 'live' && (snapshot.positions?.length ?? 0) > 0) flags.push('Prices not live')
  return (
    <div className="swing-strip" aria-label="Portfolio summary">
      <div><small>P&L</small><strong className={tone(snapshot.pnl)}>{signedRupees(snapshot.pnl)}</strong><small className={tone(snapshot.pnl)}>{signedPct(snapshot.pnl_pct)}</small></div>
      <div><small>Cash</small><strong>{rupees(snapshot.wallet_balance)}</strong></div>
      <div><small>Capital</small><strong>{rupees(portfolio.session_capital)}</strong></div>
      {flags.length > 0 && <ul className="swing-flags" aria-label="Notices">{flags.map(flag => <li key={flag}>{flag}</li>)}</ul>}
    </div>
  )
}

function PositionRow({ position, onOpen }: { position: Position; onOpen: () => void }) {
  return (
    <button type="button" role="listitem" className="swing-row" onClick={onOpen} aria-label={`${contractName(position)} ${sideWord(position)} ${position.quantity}`}>
      <span className="swing-main">
        <strong>{contractName(position)}</strong>
        <small><span className={position.side === 'SHORT' ? 'neg' : 'pos'}>{sideWord(position)}</span> {position.quantity} @ {price(position.avg_entry_price)}</small>
      </span>
      <span className="swing-num">
        <span>{price(position.mark_price)} <small className="muted">{quoteNote(position)}</small></span>
        <span className={tone(position.unrealized_pnl)}>{signedRupees(position.unrealized_pnl)} <small>{signedPct(position.unrealized_pnl_pct)}</small></span>
      </span>
    </button>
  )
}

function OrderRow({ order, onOpen }: { order: PendingOrder; onOpen: () => void }) {
  return (
    <button type="button" role="listitem" className="swing-row" onClick={onOpen} aria-label={`${contractName(order)} ${orderSummary(order)}`}>
      <span className="swing-main">
        <strong>{contractName(order)}</strong>
        <small className={order.side === 'BUY' ? 'pos' : 'neg'}>{orderSummary(order)}</small>
      </span>
      <span className="swing-num"><span>{order.swing_reconcile_pending ? 'Checking with broker' : order.status}</span></span>
    </button>
  )
}

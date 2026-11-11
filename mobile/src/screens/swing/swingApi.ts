import type { ApiClient } from '../../api/transport'
import { isAbort } from '../../api/transport'
import { SwingSseDecoder } from '../../../../shared/swingStream'
import type { AmendPreview, BrokerStatus, Broker, Capabilities, ChartHistory, ContractList, Instrument, OrderPreview, Snapshot, SwingMode } from './swingTypes'

export const SWING_BASE = '/api/desktop/v1/swing/portfolios'
/** A broker round trip can take a while on a real order; the server answers when the broker has. */
const WRITE_TIMEOUT_MS = 45_000

export interface StartBody {
  mode: SwingMode
  execution_broker: Broker
  paper_broker: Broker
  allocation_pct: number
  capital: number
  loss_limit_pct?: number
}

export interface CloseBody {
  acknowledge_delivery_context_ids: string[]
  acknowledge_undated_submission_ids: string[]
}

/** The swing calls the phone makes. Writes are never retried by the transport; the order request id makes a manual retry safe. */
export interface SwingApi {
  capabilities(signal?: AbortSignal): Promise<Capabilities>
  brokerStatus(broker: Broker): Promise<BrokerStatus>
  active(mode: SwingMode, broker: Broker, signal?: AbortSignal): Promise<Snapshot>
  portfolio(id: string, signal?: AbortSignal): Promise<Snapshot>
  start(body: StartBody): Promise<Snapshot>
  orderPreview(id: string, body: Record<string, unknown>): Promise<OrderPreview>
  placeOrder(id: string, body: Record<string, unknown>): Promise<Snapshot>
  amendPreview(id: string, orderId: string, price: number, quantity: number): Promise<AmendPreview>
  amendOrder(id: string, orderId: string, body: Record<string, unknown>): Promise<Snapshot>
  cancelOrder(id: string, orderId: string): Promise<Snapshot>
  pause(id: string, paused: boolean): Promise<Snapshot>
  close(id: string, body: CloseBody): Promise<Snapshot>
  contracts(symbol: string, instrument: Exclude<Instrument, 'equity'>, provider: Broker, signal?: AbortSignal): Promise<ContractList>
  chartHistory(id: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ChartHistory>
}

export function createSwingApi(client: ApiClient): SwingApi {
  const write = <T,>(path: string, method: 'POST' | 'PATCH', body: unknown) =>
    client.request<T>(`${SWING_BASE}${path}`, { method, body, retries: 0, timeoutMs: WRITE_TIMEOUT_MS })
  return {
    capabilities: signal => client.get<Capabilities>(`${SWING_BASE}/capabilities`, undefined, { signal }),
    brokerStatus: broker => client.get<BrokerStatus>(`${SWING_BASE}/broker-status`, { execution_broker: broker }),
    active: (mode, broker, signal) => client.get<Snapshot>(`${SWING_BASE}/active`, { mode, execution_broker: mode === 'real' ? broker : undefined }, { signal, timeoutMs: 30_000 }),
    portfolio: (id, signal) => client.get<Snapshot>(`${SWING_BASE}/${id}`, undefined, { signal, timeoutMs: 30_000 }),
    start: body => write('', 'POST', body),
    orderPreview: (id, body) => write(`/${id}/order-preview`, 'POST', body),
    placeOrder: (id, body) => write(`/${id}/orders`, 'POST', body),
    amendPreview: (id, orderId, price, quantity) => write(`/${id}/orders/${orderId}/amend-preview`, 'POST', { price, quantity }),
    amendOrder: (id, orderId, body) => write(`/${id}/orders/${orderId}`, 'PATCH', body),
    cancelOrder: (id, orderId) => write(`/${id}/orders/${orderId}/cancel`, 'POST', {}),
    pause: (id, paused) => write(`/${id}/pause`, 'POST', { paused }),
    close: (id, body) => write(`/${id}/close`, 'POST', body),
    contracts: (symbol, instrument, provider, signal) => instrument === 'futures'
      ? client.get<ContractList>(`${SWING_BASE}/contracts/futures`, { symbol, provider }, { signal })
      : client.get<ContractList>(`${SWING_BASE}/contracts/metadata`, { symbol }, { signal }),
    chartHistory: (id, body, signal) => client.request<ChartHistory>(`${SWING_BASE}/${id}/charts/history`, { method: 'POST', body, signal, retries: 0, timeoutMs: 60_000 }),
  }
}

export type PortfolioEvent =
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'refresh' }
  | { kind: 'error'; message: string }

/**
 * Follow a portfolio's event stream. The server sends a full snapshot on connect and on every change, so a reconnect
 * (with backoff) simply receives a fresh one. Returns when `signal` aborts. Read-only.
 */
export async function followPortfolio(client: ApiClient, id: string, onEvent: (event: PortfolioEvent) => void, signal: AbortSignal, onConnection?: (connected: boolean) => void): Promise<void> {
  let backoff = 1_000
  while (!signal.aborted) {
    try {
      const response = await client.stream(`${SWING_BASE}/${id}/events`, { signal })
      const reader = response.body!.getReader()
      const decoder = new SwingSseDecoder(event => {
        if (event.type === 'portfolio_snapshot' && event.portfolio?.session_id === id) onEvent({ kind: 'snapshot', snapshot: event as Snapshot })
        else if (event.type === 'portfolio_refresh_required') onEvent({ kind: 'refresh' })
        else if (event.type === 'portfolio_error') onEvent({ kind: 'error', message: String(event.message ?? 'The portfolio reported a problem.') })
      })
      onConnection?.(true)
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          backoff = 1_000
          decoder.push(value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    } catch (error) {
      if (signal.aborted || isAbort(error)) return
    }
    onConnection?.(false)
    if (signal.aborted) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, backoff)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    backoff = Math.min(backoff * 2, 30_000)
  }
}

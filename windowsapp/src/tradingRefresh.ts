export const TRADING_RECONCILE_MS = 5 * 60_000

// One coordinator per screen; identities also include backend and credentials.
export class TradingRefresh {
  private completed = new Map<string, number>()
  private pending = new Map<string, Promise<unknown>>()

  mark(key: string, now = Date.now()): void { this.completed.set(key, now) }
  due(key: string, now = Date.now()): boolean {
    if (!this.completed.has(key)) this.mark(key, now)
    return now - this.completed.get(key)! >= TRADING_RECONCILE_MS
  }
  async request<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key)
    if (existing) return existing as Promise<T>
    const request = fetch().then(value => { this.mark(key); return value })
    this.pending.set(key, request)
    try { return await request } finally { this.pending.delete(key) }
  }
}

export function eventNeedsTradingRefresh(event: Record<string, unknown>, cursor: number): boolean {
  const eventId = Number(event.event_id)
  if (Number.isFinite(eventId) && eventId <= cursor) return false
  if (event.type === 'order_filled') return !(event.trade && event.position && event.pnl)
  if (event.type === 'tick' || event.type === 'bar_paused' || event.type === 'order_placed' || event.type === 'order_updated' || event.type === 'feed_status' || event.type === 'order_cancelled' || event.type === 'order_converted' || event.type === 'strategy_completed') return false
  return true
}


export const STREAM_IDLE_TIMEOUT_MS = 60_000

export function backupReconciliationEnabled(mode: string, state?: string | null): boolean {
  return (mode === 'Paper' || mode === 'Replay' || mode === 'Browse') && state === 'running'
}

export function eventAffectsWallet(event: Record<string, unknown>): boolean {
  return ['order_placed', 'order_updated', 'order_cancelled', 'order_converted', 'order_filled'].includes(String(event.type))
}

/** Heartbeats count as transport activity even when no price events arrive. */
export async function readStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Event stream heartbeat timed out; reconnecting'))
          void reader.cancel().catch(() => undefined)
        }, STREAM_IDLE_TIMEOUT_MS)
      }),
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

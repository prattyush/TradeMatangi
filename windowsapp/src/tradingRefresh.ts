export const TRADING_RECONCILE_MS = 30_000

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
  return event.type !== 'tick' && event.type !== 'bar_paused'
}

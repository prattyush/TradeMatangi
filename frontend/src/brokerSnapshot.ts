/** Broker snapshots replace session state, so they must identify their owner. */
export function brokerSnapshotSessionId(event: Record<string, unknown>, activeSessionId: string | null): string | null {
  return activeSessionId && event.session_id === activeSessionId ? activeSessionId : null
}

/** Ignore stale responses and legacy snapshots without a valid corrected capital. */
export function refreshedSessionCapital(activeSessionId: string | null, responseSessionId: string,
  currentCapital: number, capital: number | null | undefined): number {
  return activeSessionId === responseSessionId && typeof capital === 'number' && Number.isFinite(capital)
    ? capital : currentCapital
}

/** Verification reports are not state snapshots; reject them before replacing UI state. */
export function isBrokerSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return ['orders', 'trades', 'positions', 'application_orders', 'open_orders'].every(key => Array.isArray(row[key]))
}

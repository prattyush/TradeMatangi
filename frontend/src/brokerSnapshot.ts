/** Broker snapshots replace session state, so they must identify their owner. */
export function brokerSnapshotSessionId(event: Record<string, unknown>, activeSessionId: string | null): string | null {
  return activeSessionId && event.session_id === activeSessionId ? activeSessionId : null
}

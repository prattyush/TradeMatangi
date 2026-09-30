import type { Chart, OverlayCreate } from 'klinecharts'

type OverlayChart = Pick<Chart, 'createOverlay' | 'overrideOverlay' | 'removeOverlay'>

/** Retains line identity across quote updates, selection, and order changes. */
export class TradingOverlayRegistry {
  private entries = new Map<string, { id: string; signature: string }>()

  upsert(chart: OverlayChart, key: string, overlay: OverlayCreate): void {
    const signature = JSON.stringify(overlay)
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.signature !== signature) {
        chart.overrideOverlay({ ...overlay, id: existing.id })
        existing.signature = signature
      }
      return
    }
    const id = chart.createOverlay(overlay)
    if (typeof id === 'string') this.entries.set(key, { id, signature })
  }

  prune(chart: OverlayChart, retained: Set<string>): string[] {
    const removed: string[] = []
    for (const [key, entry] of this.entries) {
      if (!retained.has(key)) {
        chart.removeOverlay({ id: entry.id })
        this.entries.delete(key)
        removed.push(key)
      }
    }
    return removed
  }

  reset(): void { this.entries.clear() }
}

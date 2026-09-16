import type { Candle, ChartSnapshot } from './contracts'
import { applyEvent, fromSnapshot, type ChartState } from './chartState'

/** The only module allowed to translate Trade Matangi contracts to KLineCharts objects. */
export class KLineAdapter {
  private state: ChartState = { candles: [], generation: 0, eventId: 0 }
  constructor(private readonly render: (candles: Candle[]) => void) {}
  loadSnapshot(snapshot: ChartSnapshot) { this.state = fromSnapshot(snapshot); this.render(this.state.candles) }
  apply(event: Parameters<typeof applyEvent>[1]) { const next = applyEvent(this.state, event); if (next !== this.state) { this.state = next; this.render(next.candles) } }
  destroy() { this.state = { candles: [], generation: 0, eventId: 0 } }
}

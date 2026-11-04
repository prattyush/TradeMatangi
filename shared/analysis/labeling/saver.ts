import type { TradeLabel } from '../api'
import { finalizeLabel, labelKey } from './model'

export interface SaverState { pending: number; saving: boolean; error: string; savedCount: number }

/**
 * Auto-save for one-at-a-time labeling.
 *
 * `edit` records the latest value of a label and (re)starts a debounce timer; `flush`
 * saves right now and resolves true only when nothing is left unsaved. Only edited
 * labels are ever sent. Saves never overlap: an edit made while a save is in flight is
 * kept and sent by the next pass, so a slow response cannot overwrite newer typing.
 */
export class LabelSaver {
  private pending = new Map<string, { label: TradeLabel; version: number }>()
  private version = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<boolean> | null = null
  private state: SaverState = { pending: 0, saving: false, error: '', savedCount: 0 }

  constructor(
    private readonly save: (labels: TradeLabel[]) => Promise<unknown>,
    private readonly onChange: (state: SaverState) => void = () => undefined,
    private readonly delayMs = 600,
  ) {}

  snapshot(): SaverState { return this.state }

  edit(label: TradeLabel) {
    this.pending.set(labelKey(label.session_id, label.round_trip_index), { label, version: ++this.version })
    this.update({ error: '' })
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, this.delayMs)
  }

  /** Forget everything unsaved (used when the data set is reloaded). */
  reset() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    this.update({ error: '' })
  }

  flush(): Promise<boolean> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.running) return this.running.then(ok => (ok && this.pending.size ? this.flush() : ok))
    if (!this.pending.size) return Promise.resolve(!this.state.error)
    this.running = this.drain().finally(() => { this.running = null })
    return this.running
  }

  private async drain(): Promise<boolean> {
    this.update({ saving: true, error: '' })
    try {
      while (this.pending.size) {
        const batch = [...this.pending.entries()]
        await this.save(batch.map(([, entry]) => finalizeLabel(entry.label)))
        for (const [key, entry] of batch) if (this.pending.get(key)?.version === entry.version) this.pending.delete(key)
        this.update({ savedCount: this.state.savedCount + batch.length })
      }
      this.update({ saving: false })
      return true
    } catch (error) {
      this.update({ saving: false, error: error instanceof Error ? error.message : 'Save failed' })
      return false
    }
  }

  private update(patch: Partial<SaverState>) {
    this.state = { ...this.state, ...patch, pending: this.pending.size }
    this.onChange(this.state)
  }
}

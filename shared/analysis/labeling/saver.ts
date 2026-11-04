import type { TradeLabel } from '../api'
import { finalizeLabel, labelKey } from './model'

export interface SaverState { pending: number; saving: boolean; error: string; savedCount: number }

export interface AutoSaverOptions<T> {
  /** Applied to each item just before it is sent. */
  prepare?: (item: T) => T
  /** Combines a still-unsaved item with a newer edit of the same key (default: the newer item wins). */
  merge?: (previous: T, next: T) => T
  delayMs?: number
}

/**
 * Debounced auto-save of keyed items.
 *
 * `edit` records the latest value of an item and (re)starts a debounce timer; `flush` saves right now and resolves
 * true only when nothing is left unsaved. Only edited items are ever sent. Saves never overlap: an edit made while a
 * save is in flight is kept and sent by the next pass, so a slow response cannot overwrite newer input.
 */
export class AutoSaver<T> {
  private pending = new Map<string, { item: T; version: number }>()
  private version = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<boolean> | null = null
  private state: SaverState = { pending: 0, saving: false, error: '', savedCount: 0 }
  private readonly delayMs: number

  constructor(
    private readonly save: (items: T[]) => Promise<unknown>,
    private readonly keyOf: (item: T) => string,
    private readonly onChange: (state: SaverState) => void = () => undefined,
    private readonly options: AutoSaverOptions<T> = {},
  ) { this.delayMs = options.delayMs ?? 600 }

  snapshot(): SaverState { return this.state }

  edit(item: T) {
    const key = this.keyOf(item)
    const previous = this.pending.get(key)?.item
    this.pending.set(key, { item: previous && this.options.merge ? this.options.merge(previous, item) : item, version: ++this.version })
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
        await this.save(batch.map(([, entry]) => this.options.prepare ? this.options.prepare(entry.item) : entry.item))
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

/** Auto-save of trade labels; unset actual pattern / tags get their defaults when sent. */
export class LabelSaver extends AutoSaver<TradeLabel> {
  constructor(save: (labels: TradeLabel[]) => Promise<unknown>, onChange: (state: SaverState) => void = () => undefined, delayMs = 600) {
    super(save, label => labelKey(label.session_id, label.round_trip_index), onChange, { prepare: finalizeLabel, delayMs })
  }
}

/** One round trip's behavior answers (`true` = showed it, `false` = cleared). */
export interface MarkEdit { session_id: string; round_trip_index: number; answers: Record<string, boolean> }

/** Auto-save of behavior marks; toggles on the same trade made before a save are combined. */
export class MarkSaver extends AutoSaver<MarkEdit> {
  constructor(save: (edits: MarkEdit[]) => Promise<unknown>, onChange: (state: SaverState) => void = () => undefined, delayMs = 400) {
    super(save, edit => labelKey(edit.session_id, edit.round_trip_index), onChange, {
      merge: (previous, next) => ({ ...next, answers: { ...previous.answers, ...next.answers } }),
      delayMs,
    })
  }
}

/** Combines the label and mark savers into the single status the panel shows. */
export function combineSaverStates(...states: SaverState[]): SaverState {
  return {
    pending: states.reduce((sum, state) => sum + state.pending, 0),
    saving: states.some(state => state.saving),
    error: states.find(state => state.error)?.error ?? '',
    savedCount: states.reduce((sum, state) => sum + state.savedCount, 0),
  }
}

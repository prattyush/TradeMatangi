/** A timed or capped block of trials, independent of any clock: the caller passes the elapsed time in. */
import type { TrialEngine, TrialLogEntry, TrialOutcome, TrialResponse } from '../../core/trial'
import { isAnticipation } from './rt'

export interface BlockOptions {
  /** Block length in seconds; no new trial starts once it has passed. Omit for a block that ends only with the engine. */
  seconds?: number
  /** Hard cap on counted trials (a safety limit). */
  maxTrials?: number
}

export interface Block<Trial, R> {
  /** The next trial, or `null` when time is up, the cap is reached or the engine has ended. */
  issue(elapsedMs: number): Trial | null
  /** Judge a response. Applies the anticipation rule, logs the trial and returns the entry. */
  answer(response: TrialResponse<R>, rtMs: number, atMs: number): TrialLogEntry<Trial, R>
  /** Throw the current trial away (bad frame timing, focus lost): it is not logged and not scored. */
  discard(): void
  readonly current: Trial | null
  readonly log: TrialLogEntry<Trial, R>[]
  readonly discarded: number
  isOver(elapsedMs: number): boolean
}

export function createBlock<Trial, R>(engine: TrialEngine<Trial, R>, options: BlockOptions = {}): Block<Trial, R> {
  const log: TrialLogEntry<Trial, R>[] = []
  let current: Trial | null = null
  let discarded = 0
  let ended = false
  const limitMs = options.seconds === undefined ? Infinity : options.seconds * 1000
  const over = (elapsedMs: number) => ended || elapsedMs >= limitMs || (options.maxTrials !== undefined && log.length >= options.maxTrials)

  return {
    issue(elapsedMs) {
      if (over(elapsedMs)) { current = null; return null }
      const trial = engine.next()
      if (trial === null) { ended = true; current = null; return null }
      current = trial
      return trial
    },
    answer(response, rtMs, atMs) {
      if (current === null) throw new Error('answer() without a current trial')
      const trial = current
      const early = response !== 'timeout' && isAnticipation(rtMs)
      let outcome: TrialOutcome = engine.evaluate(trial, response, rtMs)
      // Too early to be a real reaction: an error, and not an RT.
      if (early) outcome = { ...outcome, correct: false, anticipated: true, tag: outcome.tag === 'fa' ? 'fa' : 'early' }
      const entry: TrialLogEntry<Trial, R> = {
        n: log.length + 1, trial, response, rtMs: response === 'timeout' || early ? null : rtMs, outcome, atMs,
      }
      log.push(entry)
      current = null
      return entry
    },
    discard() {
      if (current !== null) discarded += 1
      current = null
    },
    get current() { return current },
    get log() { return log },
    get discarded() { return discarded },
    isOver: over,
  }
}

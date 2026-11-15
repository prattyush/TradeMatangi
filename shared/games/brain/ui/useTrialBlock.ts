/**
 * Runs a block of trials in the browser with the timing rules of spec 17.3 (see `engine/rt.ts`):
 *  - onset is the rAF timestamp of the frame in which the stimulus is painted (the DOM is updated with `flushSync` inside
 *    that frame's callback, so the stimulus is on screen before the frame is drawn);
 *  - reaction time is `event.timeStamp - onset`; display and window deadlines are checked against the frame clock, not timers;
 *  - a trial with a bad frame (more than 100 ms) or a display that missed its time by over 2 frames is discarded and replaced;
 *  - losing focus (tab hidden, window blur, or a dialog open over the game) discards the current trial and pauses the block
 *    clock; the shell voids the whole block if that lasts too long.
 * The engine is created inside the effect from a factory, so React StrictMode's second mount restarts cleanly and
 * deterministically (the factory builds a fresh seeded stream each time).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { TrialEngine, TrialLogEntry, TrialResponse, TrialTiming } from '../../core/trial'
import { ANTICIPATION_MS, checkTrialTiming, frameMsFrom } from '../engine/rt'
import { createBlock } from '../engine/trialEngine'

/** One input during a fixed-cadence trial: what was pressed, and the reaction time since onset. */
export interface TrialInput<I> { input: I; rtMs: number }

export interface TrialBlockOptions<Trial, R, I = R> {
  createEngine: () => TrialEngine<Trial, R>
  /** Block length. Omit for a block that ends only when the engine does (a fixed number of trials). */
  seconds?: number
  /** Hard cap on counted trials. */
  maxTrials?: number
  /**
   * For trials with `timing.fixedCadence`: the inputs collected during the window are turned into the one response the engine
   * judges when the window ends. Without it the first input is the response.
   */
  combine?: (events: TrialInput<I>[]) => TrialResponse<R>
  suspended: boolean
  /** Text of a rule or cue banner shown before a trial's stimulus (its length is `timing.preMs`). */
  banner?: (trial: Trial) => string | null
  onFinish: (result: { log: TrialLogEntry<Trial, R>[]; discarded: number }) => void
}

export interface TrialBlockApi<Trial, R, I = R> {
  /** The trial on screen (null between trials). */
  trial: Trial | null
  /** False once a timed stimulus has vanished while its response window is still open. */
  visible: boolean
  banner: string | null
  /** The trial that was just judged (feedback on the pause after it), until the next one starts. */
  last: TrialLogEntry<Trial, R> | null
  /** Report a response. `timeStamp` must be the input event's own `timeStamp`. */
  respond: (input: I, timeStamp: number) => void
  /** Block clock in ms (paused while away); for the time bar. */
  getElapsedMs: () => number
}

const AFTER_AWAY_MS = 500
const AFTER_DISCARD_MS = 300

export function useTrialBlock<Trial, R, I = R>(options: TrialBlockOptions<Trial, R, I>): TrialBlockApi<Trial, R, I> {
  const [trial, setTrial] = useState<Trial | null>(null)
  const [visible, setVisible] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [last, setLast] = useState<TrialLogEntry<Trial, R> | null>(null)
  const latest = useRef(options)
  latest.current = options
  const respondRef = useRef<(input: I, timeStamp: number) => void>(() => undefined)
  const elapsedRef = useRef<() => number>(() => 0)

  useEffect(() => {
    const engine = latest.current.createEngine()
    const block = createBlock(engine, { seconds: latest.current.seconds, maxTrials: latest.current.maxTrials })
    const totalMs = latest.current.seconds === undefined ? Infinity : latest.current.seconds * 1000
    let raf = 0
    let stopped = false
    let blockStart = -1
    let pausedMs = 0
    let awaySince: number | null = null
    let phase: 'gap' | 'banner' | 'stim' = 'gap'
    let gapUntil = 0
    let bannerUntil = 0
    let pending: { trial: Trial; timing: TrialTiming } | null = null
    let timing: TrialTiming | null = null
    let onset = 0
    let hiddenAfter: number | null = null
    let longestFrame = 0
    let lastTs = 0
    const deltas: number[] = []
    let blurred = false
    let events: TrialInput<I>[] = []

    const elapsedAt = (ts: number) => (blockStart < 0 ? 0 : ts - blockStart - pausedMs - (awaySince === null ? 0 : ts - awaySince))
    elapsedRef.current = () => elapsedAt(performance.now())

    const clearDisplay = () => flushSync(() => { setTrial(null); setVisible(false); setBanner(null) })
    const isAway = () => latest.current.suspended || document.hidden || blurred

    const markAway = (t: number) => {
      if (awaySince !== null) return
      awaySince = t
      if (phase === 'stim' || phase === 'banner') { block.discard(); pending = null; clearDisplay() }
      phase = 'gap'
    }
    const markBack = (t: number) => {
      if (awaySince === null) return
      pausedMs += t - awaySince
      awaySince = null
      gapUntil = t + AFTER_AWAY_MS
      longestFrame = 0
    }

    const finish = () => {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(raf)
      if (phase === 'stim') block.discard()
      latest.current.onFinish({ log: block.log, discarded: block.discarded })
    }

    const showStimulus = (ts: number, t: Trial, tm: TrialTiming) => {
      timing = tm
      flushSync(() => { setTrial(t); setVisible(true); setBanner(null); setLast(null) })
      onset = ts
      hiddenAfter = null
      longestFrame = 0
      events = []
      phase = 'stim'
    }

    const startTrial = (ts: number) => {
      const next = block.issue(elapsedAt(ts))
      if (next === null) { finish(); return }
      const tm = engine.timing(next)
      const text = tm.preMs ? latest.current.banner?.(next) ?? null : null
      if (tm.preMs && text) {
        pending = { trial: next, timing: tm }
        flushSync(() => { setBanner(text); setTrial(null); setVisible(false) })
        bannerUntil = ts + tm.preMs
        phase = 'banner'
      } else showStimulus(ts, next, tm)
    }

    const resolve = (response: TrialResponse<R>, rt: number, now: number) => {
      if (phase !== 'stim' || timing === null) return
      const check = checkTrialTiming(timing.displayMs, hiddenAfter, frameMsFrom(deltas), longestFrame)
      let entry: TrialLogEntry<Trial, R> | null = null
      let gapMs = AFTER_DISCARD_MS
      if (check.ok) {
        entry = block.answer(response, rt, elapsedAt(now))
        gapMs = engine.gapAfter?.(entry.trial, entry.outcome) ?? timing.gapMs
      } else block.discard()
      flushSync(() => { setTrial(null); setVisible(false); setBanner(null); setLast(entry) })
      phase = 'gap'
      gapUntil = now + gapMs
    }

    // A fixed-cadence trial (n-back) lasts its whole window: inputs are gathered and judged together when it ends. A press under
    // 150 ms cannot be a reaction to this item (it belongs to the previous one), so it is ignored.
    const resolveFixed = (now: number) => {
      const combined = latest.current.combine
        ? latest.current.combine(events)
        : events.length ? (events[0].input as unknown as R) : 'timeout'
      resolve(combined, timing?.windowMs ?? 0, now)
    }

    respondRef.current = (input, timeStamp) => {
      if (stopped || phase !== 'stim' || timing === null || awaySince !== null) return
      const rt = timeStamp - onset
      if (rt < 0) return // an event from before the stimulus was on screen
      if (timing.fixedCadence) {
        if (rt >= ANTICIPATION_MS && rt <= timing.windowMs) events.push({ input, rtMs: rt })
        return
      }
      if (rt > timing.windowMs) { resolve('timeout', timing.windowMs, performance.now()); return }
      resolve(input as unknown as R, rt, timeStamp)
    }

    const loop = (ts: number) => {
      if (stopped) return
      if (blockStart < 0) { blockStart = ts; lastTs = ts }
      const delta = ts - lastTs
      lastTs = ts
      if (delta > 0) { deltas.push(delta); if (deltas.length > 120) deltas.shift() }
      if (isAway()) { markAway(ts); raf = requestAnimationFrame(loop); return }
      if (awaySince !== null) { markBack(ts); raf = requestAnimationFrame(loop); return }
      if (phase === 'stim') longestFrame = Math.max(longestFrame, delta)

      if (elapsedAt(ts) >= totalMs) { finish(); return }
      if (phase === 'gap' && ts >= gapUntil) startTrial(ts)
      else if (phase === 'banner' && ts >= bannerUntil && pending) { const p = pending; pending = null; showStimulus(ts, p.trial, p.timing) }
      else if (phase === 'stim' && timing) {
        const t = ts - onset
        if (timing.displayMs !== null && hiddenAfter === null && t >= timing.displayMs && timing.displayMs < timing.windowMs) {
          hiddenAfter = t
          flushSync(() => setVisible(false))
        }
        if (t >= timing.windowMs) { if (timing.fixedCadence) resolveFixed(ts); else resolve('timeout', timing.windowMs, ts) }
      }
      raf = requestAnimationFrame(loop)
    }

    const onVisibility = () => { if (document.hidden) markAway(performance.now()) }
    const onBlur = () => { blurred = true; markAway(performance.now()) }
    const onFocus = () => { blurred = false }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    raf = requestAnimationFrame(loop)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      respondRef.current = () => undefined
    }
  }, [])

  const respond = useCallback((input: I, timeStamp: number) => respondRef.current(input, timeStamp), [])
  const getElapsedMs = useCallback(() => elapsedRef.current(), [])
  return { trial, visible, banner, last, respond, getElapsedMs }
}


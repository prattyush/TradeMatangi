/**
 * Runs a game made of rounds with stages (spec 17.5 memory and tracking games): a round is shown in timed stages (a sequence
 * flashes, dots move) and then the player answers with no time limit. Same rules as `useTrialBlock`:
 *  - stages are timed on the rAF clock and the DOM is updated with `flushSync` inside the frame callback;
 *  - a frame over 100 ms during a presentation stage (`critical`) discards the round and replaces it with a fresh one: the
 *    engine's state only moves when an answer is judged, so a replacement is simply the next `next()`;
 *  - losing focus or an open quit dialog discards the round in progress; the shell voids the session after 10 s away;
 *  - the answer is not a reaction time, so the anticipation rule is off (`createBlock(..., { anticipation: false })`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { StageSpec, TrialEngine, TrialLogEntry } from '../../core/trial'
import { LONG_FRAME_MS } from '../engine/rt'
import { createBlock } from '../engine/trialEngine'

export interface StagedOptions<Trial, R> {
  createEngine: () => TrialEngine<Trial, R>
  suspended: boolean
  /** Hard cap on counted rounds. */
  maxTrials?: number
  onFinish: (result: { log: TrialLogEntry<Trial, R>[]; discarded: number }) => void
}

export type StagedProgress = ReturnType<NonNullable<TrialEngine<unknown, unknown>['progress']>>

export interface StagedApi<Trial, R> {
  trial: Trial | null
  /** Name of the stage on screen, or null between rounds. */
  stage: string | null
  /** Progress reported by the engine after each judged round (span, strikes ...). */
  progress: StagedProgress | undefined
  /** The round that was just judged (shown briefly as feedback), until the next one starts. */
  last: TrialLogEntry<Trial, R> | null
  /** Hand in the answer. Only the last stage (the one with no time limit) accepts it. */
  submit: (response: R) => void
  /** Milliseconds since the current stage began (for animation). */
  getStageMs: () => number
}

const BETWEEN_MS = 900
const AFTER_AWAY_MS = 600

export function useStagedRounds<Trial, R>(options: StagedOptions<Trial, R>): StagedApi<Trial, R> {
  const [trial, setTrial] = useState<Trial | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [progress, setProgress] = useState<StagedProgress | undefined>(undefined)
  const [last, setLast] = useState<TrialLogEntry<Trial, R> | null>(null)
  const latest = useRef(options)
  latest.current = options
  const submitRef = useRef<(response: R) => void>(() => undefined)
  const stageMsRef = useRef<() => number>(() => 0)

  useEffect(() => {
    const engine = latest.current.createEngine()
    const block = createBlock(engine, { maxTrials: latest.current.maxTrials, anticipation: false })
    let raf = 0
    let stopped = false
    let phase: 'between' | 'round' = 'between'
    let betweenUntil = 0
    let stages: StageSpec[] = []
    let stageIndex = 0
    let stageStart = 0
    let lastTs = 0
    let longestCritical = 0
    let away = false
    let blurred = false

    stageMsRef.current = () => performance.now() - stageStart
    const isAway = () => latest.current.suspended || document.hidden || blurred
    const clear = () => flushSync(() => { setTrial(null); setStage(null) })

    const finish = () => {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(raf)
      latest.current.onFinish({ log: block.log, discarded: block.discarded })
    }

    const startRound = (ts: number) => {
      const next = block.issue(0)
      if (next === null) { finish(); return }
      stages = engine.stages ? engine.stages(next) : [{ name: 'respond', ms: null }]
      stageIndex = 0
      stageStart = ts
      longestCritical = 0
      phase = 'round'
      flushSync(() => { setLast(null); setTrial(next); setStage(stages[0].name) })
    }

    const goAway = (t: number) => {
      if (away) return
      away = true
      if (phase === 'round') { block.discard(); clear() }
      phase = 'between'
      betweenUntil = Number.POSITIVE_INFINITY
      void t
    }
    const comeBack = (t: number) => { if (!away) return; away = false; betweenUntil = t + AFTER_AWAY_MS }

    submitRef.current = response => {
      if (stopped || phase !== 'round' || away) return
      const spec = stages[stageIndex]
      if (!spec || spec.ms !== null) return // still presenting
      const now = performance.now()
      const entry = block.answer(response, now - stageStart, now)
      flushSync(() => { setTrial(null); setStage(null); setLast(entry); setProgress(engine.progress?.()) })
      phase = 'between'
      betweenUntil = now + BETWEEN_MS
    }

    const loop = (ts: number) => {
      if (stopped) return
      const delta = lastTs ? ts - lastTs : 0
      lastTs = ts
      if (isAway()) { goAway(ts); raf = requestAnimationFrame(loop); return }
      if (away) { comeBack(ts); raf = requestAnimationFrame(loop); return }

      if (phase === 'between') {
        if (ts >= betweenUntil) startRound(ts)
      } else {
        const spec = stages[stageIndex]
        if (spec.critical) longestCritical = Math.max(longestCritical, delta)
        if (spec.ms !== null && ts - stageStart >= spec.ms) {
          const next = stages[stageIndex + 1]
          if (spec.critical && !(next?.critical) && longestCritical > LONG_FRAME_MS) {
            block.discard(); clear(); phase = 'between'; betweenUntil = ts + 300 // a bad frame during the presentation: replace the round
          } else if (next) {
            stageIndex += 1
            stageStart = ts
            flushSync(() => setStage(next.name))
          }
        }
      }
      raf = requestAnimationFrame(loop)
    }

    const onVisibility = () => { if (document.hidden) goAway(performance.now()) }
    const onBlur = () => { blurred = true; goAway(performance.now()) }
    const onFocus = () => { blurred = false }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    betweenUntil = performance.now() + 400
    raf = requestAnimationFrame(loop)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      submitRef.current = () => undefined
    }
  }, [])

  const submit = useCallback((response: R) => submitRef.current(response), [])
  const getStageMs = useCallback(() => stageMsRef.current(), [])
  return { trial, stage, progress, last, submit, getStageMs }
}

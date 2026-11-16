import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { catalogueEntry } from '../core/ids'
import { paramsAt } from '../core/difficulty'
import { createRng, sessionSeed } from '../core/rng'
import { FOCUS_LOSS_LIMIT_MS, initialShell, shellReducer, shouldRecord } from '../core/shell'
import { isTimedBlock, type AnyGameDefinition, type SessionMode, type SessionSummary } from '../core/types'
import { localDate } from '../core/uid'
import { TrialReview } from './TrialReview'
import { playTone } from './sound'

export interface ShellDone { mode: SessionMode; level: number; summary: SessionSummary; minutes: number; seed: number }
interface Props {
  definition: AnyGameDefinition
  /** The player's current level (Progress mode plays at it). */
  level: number
  userId: string
  sessionNo: number
  /** Called once with a finished session; nothing is called for a quit or a void. */
  onDone: (done: ShellDone) => void
  onExit: () => void
  /** Slower movement in the two games that depend on it (Settings, spec 17.3). */
  reduceMotion?: boolean
  /** Tones on the countdown and the result (Settings, off by default). */
  sound?: boolean
  /** Review: play exactly the session that was played (same seed, same level) in Practice mode. */
  replay?: { seed: number; level: number }
  /** Daily Warm-up: a line above the game ("Step 2 of 5") and a way to leave the step without finishing it. */
  stepLabel?: string
  onSkip?: () => void
}

/** instructions -> Practice/Progress -> 3-2-1 -> game View -> result. Keys are handled on this element only. */
export function GameShell({ definition, level, userId, sessionNo, onDone, onExit, reduceMotion = false, sound = false, replay, stepLabel, onSkip }: Props) {
  const timed = isTimedBlock(definition)
  const [state, dispatch] = useReducer(shellReducer, undefined, () => initialShell(timed, level))
  const root = useRef<HTMLDivElement>(null)
  const startedAt = useRef(0)
  const recorded = useRef(false)
  const entry = catalogueEntry(definition.id)
  const [practiceLevel, setPracticeLevel] = useState(replay?.level ?? level)

  const seed = useMemo(() => replay?.seed ?? sessionSeed(userId, localDate(), definition.id, sessionNo), [replay, userId, definition.id, sessionNo])
  const params = useMemo(() => {
    const base = paramsAt(definition.paramTable, state.level)
    return reduceMotion && definition.reducedMotionParams ? definition.reducedMotionParams(base) : base
  }, [definition, state.level, reduceMotion])
  useEffect(() => { root.current?.focus() }, [state.phase])
  useEffect(() => {
    if (!sound) return
    if (state.phase === 'countdown') playTone('tick')
    else if (state.phase === 'playing' && state.countdown === 0) playTone('go')
  }, [sound, state.phase, state.countdown])
  useEffect(() => { if (sound && state.phase === 'result' && state.summary) playTone(state.summary.score >= 50 ? 'good' : 'low') }, [sound, state.phase, state.summary])

  useEffect(() => {
    if (state.phase !== 'countdown' || state.quitFrom) return
    const timer = window.setTimeout(() => dispatch({ type: 'tick' }), 1000)
    return () => window.clearTimeout(timer)
  }, [state.phase, state.countdown, state.quitFrom])

  useEffect(() => { if (state.phase === 'playing' && !startedAt.current) startedAt.current = performance.now() }, [state.phase])

  // Focus loss: the current block is voided after FOCUS_LOSS_LIMIT_MS away (spec 17.3). Not a key handler.
  useEffect(() => {
    if (state.phase !== 'playing' && state.phase !== 'countdown') return
    let timer: number | undefined
    const away = () => { if (timer === undefined) timer = window.setTimeout(() => dispatch({ type: 'void', reason: 'The window lost focus for too long.' }), FOCUS_LOSS_LIMIT_MS) }
    const back = () => { if (timer !== undefined) { window.clearTimeout(timer); timer = undefined } }
    const onVisibility = () => (document.hidden ? away() : back())
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', away)
    window.addEventListener('focus', back)
    return () => { back(); document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('blur', away); window.removeEventListener('focus', back) }
  }, [state.phase])

  // A quit prompt left open over a timed block counts like losing focus: after the limit the block is voided.
  useEffect(() => {
    if (!state.quitFrom || !state.timed || state.phase !== 'playing') return
    const timer = window.setTimeout(() => dispatch({ type: 'void', reason: 'The quit prompt was left open too long.' }), FOCUS_LOSS_LIMIT_MS)
    return () => window.clearTimeout(timer)
  }, [state.quitFrom, state.timed, state.phase])

  useEffect(() => {
    if (!shouldRecord(state) || recorded.current || !state.summary) return
    recorded.current = true
    onDone({ mode: state.mode, level: state.level, summary: state.summary, minutes: Math.max(0.1, Math.round(((performance.now() - startedAt.current) / 60000) * 10) / 10), seed })
  }, [state, onDone, seed])

  const rng = useMemo(() => createRng(seed), [seed])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    if (state.quitFrom) dispatch({ type: 'cancelQuit' })
    else if (state.phase === 'instructions' || state.phase === 'result' || state.phase === 'voided') onExit()
    else dispatch({ type: 'requestQuit' })
  }

  const View = definition.View
  return (
    <div ref={root} className="games-shell" tabIndex={0} onKeyDown={onKeyDown} data-phase={state.phase}>
      {stepLabel && <p className="games-step" role="status">{stepLabel}{onSkip && state.phase !== 'playing' && state.phase !== 'countdown' && <> <button onClick={onSkip}>Skip this step</button></>}</p>}
      <header className="games-shell-head"><strong>{definition.title}</strong><span>{entry.category}{timed ? ' · timed' : ''}</span></header>
      {state.phase === 'instructions' && (
        <section>
          <p>{definition.blurb}</p>
          <ul>{definition.instructions.map(line => <li key={line}>{line}</li>)}</ul>
          {reduceMotion && definition.reducedMotionParams && <p className="games-meta">Reduce motion is on: things move more slowly in this game. Your score is calculated the same way.</p>}
          {replay ? (
            <>
              <p>Replaying a past session: the same puzzles, at level {replay.level}. Nothing is saved.</p>
              <div className="games-row">
                <button onClick={() => dispatch({ type: 'start', mode: 'practice', level: replay.level })}>Replay</button>
                <button onClick={onExit}>Back</button>
              </div>
            </>
          ) : (
            <>
              <p>Your level: {level}</p>
              <div className="games-row">
                <button onClick={() => dispatch({ type: 'start', mode: 'progress', level })}>Progress (level {level})</button>
                <button onClick={onExit}>Back</button>
              </div>
              <div className="games-row">
                <label htmlFor="games-practice-level">Practice at level <input id="games-practice-level" type="number" min={1} max={20} value={practiceLevel} onChange={event => setPracticeLevel(Math.min(20, Math.max(1, Math.round(Number(event.target.value)) || 1)))} style={{ width: 56 }} /></label>
                <button onClick={() => dispatch({ type: 'start', mode: 'practice', level: practiceLevel })}>Practice</button>
              </div>
            </>
          )}
        </section>
      )}
      {state.phase === 'countdown' && <div className="games-countdown" role="status">{state.countdown}</div>}
      {(state.phase === 'playing' || state.phase === 'paused') && (
        <View level={state.level} mode={state.mode} params={params} rng={rng} seed={seed} suspended={state.quitFrom !== null}
          onFinish={summary => dispatch({ type: 'finish', summary })} onAbort={reason => dispatch({ type: 'void', reason })} />
      )}
      {state.phase === 'result' && state.summary && (
        <section role="status">
          <h3>Score {state.summary.score}</h3>
          <p>{state.mode === 'progress' ? 'Saved to your progress.' : 'Practice session: your level does not change.'}</p>
          {state.summary.stats && <p className="games-meta">{Object.entries(state.summary.stats).slice(0, 8).map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`).join(' · ')}</p>}
          {state.summary.review && <TrialReview rows={state.summary.review} />}
          <div className="games-row"><button onClick={() => { recorded.current = false; startedAt.current = 0; dispatch({ type: 'again' }) }}>Play again</button><button onClick={onExit}>Back to games</button></div>
        </section>
      )}
      {state.phase === 'voided' && (
        <section role="alert"><p>This session was cancelled: {state.voidReason}</p><p>Nothing was recorded.</p><div className="games-row"><button onClick={() => dispatch({ type: 'again' })}>Try again</button><button onClick={onExit}>Back to games</button></div></section>
      )}
      {state.quitFrom && (
        <div className="games-confirm" role="dialog" aria-label="Quit this session?">
          <p>Quit this session? Nothing will be recorded.</p>
          <div className="games-row"><button onClick={() => { dispatch({ type: 'confirmQuit' }); onExit() }}>Quit</button><button onClick={() => dispatch({ type: 'cancelQuit' })}>Keep playing</button></div>
        </div>
      )}
    </div>
  )
}

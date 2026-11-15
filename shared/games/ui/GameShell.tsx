import { useEffect, useMemo, useReducer, useRef } from 'react'
import { catalogueEntry } from '../core/ids'
import { paramsAt } from '../core/difficulty'
import { sessionRng } from '../core/rng'
import { FOCUS_LOSS_LIMIT_MS, initialShell, shellReducer, shouldRecord } from '../core/shell'
import { isTimedBlock, type AnyGameDefinition, type SessionMode, type SessionSummary } from '../core/types'
import { localDate } from '../core/uid'

export interface ShellDone { mode: SessionMode; level: number; summary: SessionSummary; minutes: number }
interface Props {
  definition: AnyGameDefinition
  /** The player's current level (Progress mode plays at it). */
  level: number
  userId: string
  sessionNo: number
  /** Called once with a finished session; nothing is called for a quit or a void. */
  onDone: (done: ShellDone) => void
  onExit: () => void
}

/** instructions -> Practice/Progress -> 3-2-1 -> game View -> result. Keys are handled on this element only. */
export function GameShell({ definition, level, userId, sessionNo, onDone, onExit }: Props) {
  const timed = isTimedBlock(definition)
  const [state, dispatch] = useReducer(shellReducer, undefined, () => initialShell(timed, level))
  const root = useRef<HTMLDivElement>(null)
  const startedAt = useRef(0)
  const recorded = useRef(false)
  const entry = catalogueEntry(definition.id)

  useEffect(() => { root.current?.focus() }, [state.phase])

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

  useEffect(() => {
    if (!shouldRecord(state) || recorded.current || !state.summary) return
    recorded.current = true
    onDone({ mode: state.mode, level: state.level, summary: state.summary, minutes: Math.max(0.1, Math.round(((performance.now() - startedAt.current) / 60000) * 10) / 10) })
  }, [state, onDone])

  const params = useMemo(() => paramsAt(definition.paramTable, state.level), [definition, state.level])
  const rng = useMemo(() => sessionRng(userId, localDate(), definition.id, sessionNo), [userId, definition.id, sessionNo])

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
      <header className="games-shell-head"><strong>{definition.title}</strong><span>{entry.category}{timed ? ' · timed' : ''}</span></header>
      {state.phase === 'instructions' && (
        <section>
          <p>{definition.blurb}</p>
          <ul>{definition.instructions.map(line => <li key={line}>{line}</li>)}</ul>
          <p>Level {level}</p>
          <div className="games-row">
            <button onClick={() => dispatch({ type: 'start', mode: 'progress', level })}>Progress (level {level})</button>
            <button onClick={() => dispatch({ type: 'start', mode: 'practice', level })}>Practice</button>
            <button onClick={onExit}>Back</button>
          </div>
        </section>
      )}
      {state.phase === 'countdown' && <div className="games-countdown" role="status">{state.countdown}</div>}
      {(state.phase === 'playing' || state.phase === 'paused') && (
        <View level={state.level} mode={state.mode} params={params} rng={rng}
          onFinish={summary => dispatch({ type: 'finish', summary })} onAbort={reason => dispatch({ type: 'void', reason })} />
      )}
      {state.phase === 'result' && state.summary && (
        <section role="status">
          <h3>Score {state.summary.score}</h3>
          <p>{state.mode === 'progress' ? 'Saved to your progress.' : 'Practice session: your level does not change.'}</p>
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

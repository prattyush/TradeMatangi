import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { ROUND_COUNTS } from '../../config/difficulty.brain'
import { parseTyped } from '../../engine/arithmetic'
import { KeyHint } from '../../ui/KeyHint'
import { ResponsePad } from '../../ui/ResponsePad'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { buildSeries } from '../reasoning/host'
import { createNumberSeriesEngine, summariseNumberSeries, type NsrResponse, type NsrTrial } from './engine'
import type { SeriesPuzzle } from './generator'

/** Builds the puzzle set (in a Worker when there is one), then hands it to the play view. */
export default function NumberSeriesView(props: GameViewProps) {
  const [puzzles, setPuzzles] = useState<SeriesPuzzle[] | null>(null)
  const { params, seed } = props
  const abort = useRef(props.onAbort)
  abort.current = props.onAbort
  useEffect(() => {
    let cancelled = false
    buildSeries({ params, seed, count: ROUND_COUNTS.number_series })
      .then(set => { if (!cancelled) setPuzzles(set) })
      .catch(() => { if (!cancelled) abort.current('The puzzles could not be built.') })
    return () => { cancelled = true }
  }, [params, seed])
  if (!puzzles) return <div className="brain-stage"><p className="brain-hint" role="status">Preparing the puzzles{'…'}</p></div>
  return <NumberSeriesPlay {...props} puzzles={puzzles} />
}

function NumberSeriesPlay({ level, params, seed, suspended, onFinish, puzzles }: GameViewProps & { puzzles: SeriesPuzzle[] }) {
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const createEngine = useCallback(() => createNumberSeriesEngine(params, createRng(seed), puzzles), [params, seed, puzzles])
  const block = useTrialBlock<NsrTrial, NsrResponse>({
    createEngine, maxTrials: ROUND_COUNTS.number_series, suspended,
    onFinish: ({ log }) => onFinish(summariseNumberSeries(log, level)),
  })
  const { trial } = block
  const typed = params.typed >= 1
  const [shown, setShown] = useState(0)
  useEffect(() => { if (trial) { setShown(count => count + 1); setText('') } }, [trial])
  useEffect(() => { (typed ? input.current : root.current)?.focus() }, [trial, typed])
  const submitTyped = (timeStamp: number) => {
    const value = parseTyped(text)
    if (value !== null) block.respond(value, timeStamp)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat || !trial) return
    if (typed) { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); submitTyped(event.timeStamp) }; return }
    if (/^[1-5]$/.test(event.key)) { event.stopPropagation(); block.respond(trial.puzzle.options[Number(event.key) - 1], event.timeStamp) }
  }
  return (
    <div ref={root} className="brain-stage" tabIndex={typed ? undefined : 0} onKeyDown={onKeyDown} onBlur={() => { if (!typed) root.current?.focus() }}>
      <div className="brain-status"><span>Puzzle {Math.min(shown, ROUND_COUNTS.number_series)} of {ROUND_COUNTS.number_series}</span><span>What comes next?</span></div>
      <div className="brain-limitbar">{trial && <div key={shown} style={{ animationDuration: `${trial.limitMs}ms` }} />}</div>
      <div className="brain-arena" style={{ padding: 16 }}>
        {trial && (
          <div className="brain-series" aria-label="series">
            {trial.puzzle.terms.map((term, i) => <span key={i}>{term}</span>)}
            <span className="brain-series-missing" aria-label="missing term">?</span>
          </div>
        )}
      </div>
      {typed ? (
        <>
          <input ref={input} className="brain-answer" inputMode="numeric" autoComplete="off" aria-label="Your answer" value={text} disabled={!trial}
            onChange={event => setText(event.target.value.replace(/[^0-9.\-−]/g, ''))} onBlur={() => requestAnimationFrame(() => input.current?.focus())} />
          <ResponsePad buttons={[{ id: 'enter', label: 'Enter answer', hint: 'Enter', onPress: ts => submitTyped(ts), disabled: !trial }]} />
        </>
      ) : (
        <div className="brain-options" role="group" aria-label="Options">
          {trial?.puzzle.options.map((option, i) => (
            <button key={i} type="button" tabIndex={-1} className="brain-numopt" aria-label={`Option ${i + 1}: ${option}`}
              onPointerDown={event => { event.preventDefault(); block.respond(option, event.timeStamp) }}>
              {option}<KeyHint>{String(i + 1)}</KeyHint>
            </button>
          ))}
        </div>
      )}
      <p className="brain-hint">{typed ? 'Type the next term and press Enter.' : 'Press 1 to 5 or click the next term.'}</p>
    </div>
  )
}

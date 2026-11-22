import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { ROUND_COUNTS } from '../../config/difficulty.brain'
import { KeyHint } from '../../ui/KeyHint'
import { PatternDefs } from '../../ui/Stimulus'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { buildMatrices } from '../reasoning/host'
import { createPatternMatrixEngine, describeFigure, summarisePatternMatrix, type PmResponse, type PmTrial } from './engine'
import { FigureView, PM_PREFIX } from './FigureView'
import type { MatrixPuzzle } from './generator'

/** Builds the puzzle set (in a Worker when there is one), then hands it to the play view. */
export default function PatternMatrixView(props: GameViewProps) {
  const [puzzles, setPuzzles] = useState<MatrixPuzzle[] | null>(null)
  const { params, seed } = props
  const abort = useRef(props.onAbort)
  abort.current = props.onAbort
  useEffect(() => {
    let cancelled = false
    buildMatrices({ params, seed, count: ROUND_COUNTS.pattern_matrix })
      .then(set => { if (!cancelled) setPuzzles(set) })
      .catch(() => { if (!cancelled) abort.current('The puzzles could not be built.') })
    return () => { cancelled = true }
  }, [params, seed])
  if (!puzzles) return <div className="brain-stage"><p className="brain-hint" role="status">Preparing the puzzles{'…'}</p></div>
  return <PatternMatrixPlay {...props} puzzles={puzzles} />
}

function PatternMatrixPlay({ level, params, seed, suspended, onFinish, puzzles }: GameViewProps & { puzzles: MatrixPuzzle[] }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createPatternMatrixEngine(params, createRng(seed), puzzles), [params, seed, puzzles])
  const block = useTrialBlock<PmTrial, PmResponse>({
    createEngine, maxTrials: ROUND_COUNTS.pattern_matrix, suspended,
    onFinish: ({ log }) => onFinish(summarisePatternMatrix(log, level)),
  })
  const { trial } = block
  const [shown, setShown] = useState(0)
  useEffect(() => { if (trial) setShown(count => count + 1) }, [trial])
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat || !trial || !/^[1-9]$/.test(event.key)) return
    const index = Number(event.key) - 1
    if (index < trial.puzzle.options.length) { event.stopPropagation(); block.respond(index, event.timeStamp) }
  }
  const puzzle = trial?.puzzle
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <PatternDefs prefix={PM_PREFIX} />
      <div className="brain-status"><span>Puzzle {Math.min(shown, ROUND_COUNTS.pattern_matrix)} of {ROUND_COUNTS.pattern_matrix}</span><span>Which figure completes the grid?</span></div>
      <div className="brain-limitbar">{trial && <div key={shown} style={{ animationDuration: `${trial.limitMs}ms` }} />}</div>
      <div className="brain-arena" style={{ flexDirection: 'column', gap: 10, padding: 10 }}>
        {puzzle && (
          <div className="brain-matrix" role="group" aria-label="Matrix">
            {puzzle.cells.map((cell, i) => <div key={i} className="brain-matrix-cell"><FigureView figure={cell} label={describeFigure(cell)} /></div>)}
            <div className="brain-matrix-cell brain-matrix-missing" aria-label="Missing figure">?</div>
          </div>
        )}
      </div>
      <div className="brain-options" role="group" aria-label="Options">
        {puzzle?.options.map((option, i) => (
          <button key={i} type="button" tabIndex={-1} className="brain-option" aria-label={`Option ${i + 1}: ${describeFigure(option)}`}
            onPointerDown={event => { event.preventDefault(); block.respond(i, event.timeStamp) }}>
            <FigureView figure={option} size={70} /><KeyHint>{String(i + 1)}</KeyHint>
          </button>
        ))}
      </div>
      <p className="brain-hint">Work out how each kind of change runs along the rows, then pick the figure for the empty cell. Press 1 to {puzzle?.options.length ?? 8} or click.</p>
    </div>
  )
}

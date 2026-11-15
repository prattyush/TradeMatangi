import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { ROUND_COUNTS } from '../../config/difficulty.brain'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { createMakeTargetEngine, summariseMakeTarget, type MtResponse, type MtTrial } from './engine'
import { buildPuzzles } from './host'
import { apply, OPERATOR_SIGN, type Operator, type Puzzle } from './solver'

const OPERATORS: Operator[] = ['+', '-', '*', '/']
const OPERATOR_KEYS: Record<string, Operator> = { '+': '+', '-': '-', '*': '*', x: '*', '/': '/' }

interface Tile { id: number; value: number }

/** Builds the puzzle set (in a Worker when there is one), then hands it to the play view. */
export default function MakeTargetView(props: GameViewProps) {
  const [puzzles, setPuzzles] = useState<Puzzle[] | null>(null)
  const { params, seed } = props
  const abort = useRef(props.onAbort)
  abort.current = props.onAbort
  useEffect(() => {
    let cancelled = false
    buildPuzzles({ params, seed, count: ROUND_COUNTS.make_target })
      .then(set => { if (!cancelled) setPuzzles(set) })
      .catch(() => { if (!cancelled) abort.current('The puzzles could not be built.') })
    return () => { cancelled = true }
  }, [params, seed])
  if (!puzzles) return <div className="brain-stage"><p className="brain-hint" role="status">Preparing the puzzles{'…'}</p></div>
  return <MakeTargetPlay {...props} puzzles={puzzles} />
}

function MakeTargetPlay({ level, params, seed, suspended, onFinish, puzzles }: GameViewProps & { puzzles: Puzzle[] }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createMakeTargetEngine(params, createRng(seed), puzzles), [params, seed, puzzles])
  const block = useTrialBlock<MtTrial, MtResponse>({
    createEngine, maxTrials: ROUND_COUNTS.make_target, suspended,
    onFinish: ({ log }) => onFinish(summariseMakeTarget(log, level)),
  })
  const { trial } = block
  const [shown, setShown] = useState(0)
  const [tiles, setTiles] = useState<Tile[]>([])
  const [history, setHistory] = useState<Tile[][]>([])
  const [first, setFirst] = useState<number | null>(null)
  const [operator, setOperator] = useState<Operator | null>(null)
  const [notice, setNotice] = useState('')
  const initial = trial?.puzzle.numbers.length ?? 0

  useEffect(() => {
    if (!trial) return
    setShown(count => count + 1)
    setTiles(trial.puzzle.numbers.map((value, id) => ({ id, value })))
    setHistory([]); setFirst(null); setOperator(null); setNotice('')
  }, [trial])

  const submit = (list: Tile[], timeStamp: number) => {
    if (!trial || !list.length) return
    const closest = list.reduce((best, tile) => (Math.abs(tile.value - trial.puzzle.target) < Math.abs(best.value - trial.puzzle.target) ? tile : best))
    block.respond({ value: closest.value, steps: initial - list.length }, timeStamp)
  }
  const pickTile = (index: number, timeStamp: number) => {
    if (!trial) return
    setNotice('')
    if (first === null) { setFirst(index); return }
    if (operator === null) { setFirst(index === first ? null : index); return }
    if (index === first) return
    const result = apply(tiles[first].value, operator, tiles[index].value)
    if (result === null) {
      setNotice(operator === '/' ? 'That does not divide exactly (or divides by 1).' : operator === '-' ? 'A subtraction must stay above zero.' : 'Multiplying by 1 changes nothing.')
      setFirst(null); setOperator(null); return
    }
    const next = [...tiles.filter((_, i) => i !== first && i !== index), { id: 1000 + history.length, value: result }]
    setHistory(h => [...h, tiles]); setTiles(next); setFirst(null); setOperator(null)
    if (result === trial.puzzle.target) submit(next, timeStamp)
  }
  const undo = () => { setHistory(h => { const prev = h[h.length - 1]; if (prev) { setTiles(prev); setFirst(null); setOperator(null); setNotice('') } return h.slice(0, -1) }) }
  const reset = () => { if (!trial) return; setTiles(trial.puzzle.numbers.map((value, id) => ({ id, value }))); setHistory([]); setFirst(null); setOperator(null); setNotice('') }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    if (/^[1-9]$/.test(event.key) && Number(event.key) <= tiles.length) { event.stopPropagation(); pickTile(Number(event.key) - 1, event.timeStamp) }
    else if (OPERATOR_KEYS[event.key] && first !== null) { event.stopPropagation(); setOperator(OPERATOR_KEYS[event.key]) }
    else if (event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); undo() }
    else if (event.key.toLowerCase() === 'r') { event.stopPropagation(); reset() }
    else if (event.key === 'Enter' && trial && trial.tolerance > 0) { event.stopPropagation(); submit(tiles, event.timeStamp) }
  }
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <div className="brain-status"><span>Puzzle {Math.min(shown, ROUND_COUNTS.make_target)} of {ROUND_COUNTS.make_target}</span><span>{trial ? `Needs at least ${trial.puzzle.depth} operations` : ''}</span></div>
      <div className="brain-limitbar">{trial && <div key={shown} style={{ animationDuration: `${trial.limitMs}ms` }} />}</div>
      <div className="brain-arena" style={{ flexDirection: 'column', gap: 12, padding: 12 }}>
        {trial && <div className="brain-target" aria-label="target">Target <strong>{trial.puzzle.target}</strong></div>}
        <div className="brain-tiles" role="group" aria-label="Numbers">
          {trial && tiles.map((tile, index) => (
            <button key={tile.id} type="button" tabIndex={-1} className="brain-tile-num" data-selected={first === index ? 'true' : undefined} data-made={tile.id >= 1000 ? 'true' : undefined}
              onPointerDown={event => { event.preventDefault(); pickTile(index, event.timeStamp) }}>
              {tile.value}<span className="brain-key">{index + 1}</span>
            </button>
          ))}
        </div>
        <div className="brain-ops" role="group" aria-label="Operators">
          {OPERATORS.map(op => (
            <button key={op} type="button" tabIndex={-1} className="brain-op" data-selected={operator === op ? 'true' : undefined} disabled={first === null}
              onPointerDown={event => { event.preventDefault(); setOperator(op) }}>{OPERATOR_SIGN[op]}</button>
          ))}
        </div>
        <div className="brain-feedback" role="status" data-ok="false">{notice || ' '}</div>
      </div>
      <div className="brain-pad">
        <button type="button" tabIndex={-1} onPointerDown={event => { event.preventDefault(); undo() }} disabled={!history.length}>Undo <kbd className="brain-key">Backspace</kbd></button>
        <button type="button" tabIndex={-1} onPointerDown={event => { event.preventDefault(); reset() }} disabled={!history.length}>Reset <kbd className="brain-key">R</kbd></button>
        {trial && trial.tolerance > 0 && <button type="button" tabIndex={-1} onPointerDown={event => { event.preventDefault(); submit(tiles, event.timeStamp) }}>Submit closest <kbd className="brain-key">Enter</kbd></button>}
      </div>
      <p className="brain-hint">Click a number, an operator, then another number (or press 1 to 9, then + - * /). Reaching the target submits it.</p>
    </div>
  )
}

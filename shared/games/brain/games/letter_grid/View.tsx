import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { TimeBar } from '../../ui/TimeBar'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { buildGrids } from '../words/host'
import { createLetterGridEngine, GRID_SECONDS, summariseLetterGrid, type LgResponse, type LgTrial } from './engine'
import type { GridPuzzle } from './generator'

/** Builds the grid (in a Worker when there is one), then hands it to the play view. */
export default function LetterGridView(props: GameViewProps) {
  const [grids, setGrids] = useState<GridPuzzle[] | null>(null)
  const { params, seed } = props
  const abort = useRef(props.onAbort)
  abort.current = props.onAbort
  useEffect(() => {
    let cancelled = false
    buildGrids({ params, seed, count: 1 })
      .then(set => { if (!cancelled) setGrids(set) })
      .catch(() => { if (!cancelled) abort.current('The word list could not be loaded.') })
    return () => { cancelled = true }
  }, [params, seed])
  if (!grids) return <div className="brain-stage"><p className="brain-hint" role="status">Loading the word list and building the grid{'…'}</p></div>
  return <LetterGridPlay {...props} grids={grids} />
}

const adjacent = (a: number, b: number, n: number) => a !== b && Math.abs(Math.floor(a / n) - Math.floor(b / n)) <= 1 && Math.abs((a % n) - (b % n)) <= 1

function LetterGridPlay({ level, params, seed, suspended, onFinish, grids }: GameViewProps & { grids: GridPuzzle[] }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createLetterGridEngine(params, createRng(seed), grids), [params, seed, grids])
  const block = useTrialBlock<LgTrial, LgResponse>({
    createEngine, suspended,
    onFinish: ({ log }) => onFinish(summariseLetterGrid(log, level)),
  })
  const { trial } = block
  const puzzle = trial?.puzzle
  const [chain, setChain] = useState<number[]>([])
  const [typed, setTyped] = useState('')
  const [path, setPath] = useState<number[]>([])
  const [found, setFound] = useState<string[]>([])
  const [invalid, setInvalid] = useState(0)
  const [repeats, setRepeats] = useState(0)
  const [notice, setNotice] = useState('')
  const dragging = useRef(false)
  const state = useRef({ found, invalid, repeats })
  state.current = { found, invalid, repeats }

  const word = puzzle ? (chain.length ? chain.map(i => puzzle.letters[i]).join('') : typed) : ''
  const finish = useCallback((timeStamp: number) => {
    block.respond({ words: state.current.found, invalid: state.current.invalid, repeats: state.current.repeats }, timeStamp)
  }, [block])
  // The game ends at 2 minutes on the block's frame clock.
  useEffect(() => {
    if (!trial) return
    let raf = 0
    const check = () => {
      if (block.getElapsedMs() >= GRID_SECONDS * 1000) { finish(performance.now()); return }
      raf = requestAnimationFrame(check)
    }
    raf = requestAnimationFrame(check)
    return () => cancelAnimationFrame(raf)
  }, [trial, block, finish])

  const submit = () => {
    if (!puzzle || word.length === 0) return
    const entry = puzzle.words.find(w => w.word === word)
    if (!entry) { setInvalid(count => count + 1); setNotice(word.length < puzzle.minLen ? `Words need at least ${puzzle.minLen} letters.` : `"${word}" is not a word in this grid.`) }
    else if (found.includes(word)) { setRepeats(count => count + 1); setNotice(`"${word}" is already found.`) }
    else { setFound(list => [...list, word]); setNotice(`${word} +${entry.value}`); setPath(entry.path) }
    if (entry) setPath(chain.length ? chain : entry.path)
    setChain([]); setTyped('')
  }
  const addCell = (cell: number) => {
    if (!puzzle) return
    setTyped(''); setPath([])
    setChain(list => {
      if (list.includes(cell)) return list.length >= 2 && list[list.length - 2] === cell ? list.slice(0, -1) : list
      return list.length === 0 || adjacent(list[list.length - 1], cell, puzzle.n) ? [...list, cell] : [cell]
    })
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat && event.key !== 'Backspace') return
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); submit() }
    else if (event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); if (chain.length) setChain(list => list.slice(0, -1)); else setTyped(text => text.slice(0, -1)) }
    else if (/^[a-z]$/i.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) { event.stopPropagation(); setChain([]); setPath([]); setTyped(text => text + event.key.toLowerCase()) }
  }
  // Typed words show their path; clicked chains are the path.
  const typedPath = puzzle && typed ? puzzle.words.find(w => w.word === typed)?.path ?? [] : []
  const highlight = new Set(chain.length ? chain : typedPath.length ? typedPath : path)
  const value = puzzle ? found.reduce((sum, w) => sum + (puzzle.words.find(x => x.word === w)?.value ?? 0), 0) : 0
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()} onPointerUp={() => { dragging.current = false }}>
      <TimeBar getElapsedMs={block.getElapsedMs} totalMs={GRID_SECONDS * 1000} />
      <div className="brain-status"><span>Words {found.length} · value {value}</span><span>Target about {puzzle ? Math.round(params.targetShare * puzzle.commonValue) : 0}</span></div>
      <div className="brain-arena" style={{ flexDirection: 'column', gap: 10, padding: 12 }}>
        {puzzle && (
          <div className="brain-lettergrid" role="group" aria-label="Letter grid" style={{ gridTemplateColumns: `repeat(${puzzle.n}, 62px)` }}>
            {puzzle.letters.map((letter, i) => (
              <button key={i} type="button" tabIndex={-1} className="brain-cell" data-chain={chain.includes(i) ? 'true' : undefined} data-path={!chain.includes(i) && highlight.has(i) ? 'true' : undefined}
                aria-label={`Letter ${letter.toUpperCase()}`}
                onPointerDown={event => { event.preventDefault(); dragging.current = true; addCell(i) }}
                onPointerEnter={event => { if (dragging.current && event.buttons === 1) addCell(i) }}>{letter.toUpperCase()}</button>
            ))}
          </div>
        )}
        <div className="brain-problem" style={{ fontSize: '2em', minHeight: '1.2em' }} aria-label="Current word">{word.toUpperCase() || ' '}</div>
        <div className="brain-feedback" role="status">{notice || ' '}</div>
      </div>
      <div className="brain-found" aria-label="Words found">{found.map(w => <span key={w} data-common={puzzle?.words.find(x => x.word === w)?.common ? 'true' : 'false'}>{w}</span>)}</div>
      <div className="brain-pad">
        <button type="button" tabIndex={-1} onPointerDown={event => { event.preventDefault(); submit() }} disabled={!word}>Submit <kbd className="brain-key">Enter</kbd></button>
        <button type="button" tabIndex={-1} onPointerDown={event => { event.preventDefault(); setChain([]); setTyped('') }} disabled={!word}>Clear</button>
        <button type="button" tabIndex={-1} onPointerDown={event => { event.preventDefault(); finish(event.timeStamp) }} disabled={!trial}>Finish now</button>
      </div>
      <p className="brain-hint">Click or drag across touching letters, or type the word, then press Enter. Faint dashed words are rare ones: they still count.</p>
    </div>
  )
}

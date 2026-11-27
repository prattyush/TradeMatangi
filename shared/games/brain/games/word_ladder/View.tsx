import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { ROUND_COUNTS } from '../../config/difficulty.brain'
import { ResponsePad } from '../../ui/ResponsePad'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { buildLadders } from '../words/host'
import { createWordLadderEngine, summariseWordLadder, type WlResponse, type WlTrial } from './engine'
import { buildLadderGraph, oneLetterApart, shortestPath, type LadderGraph, type LadderPuzzle } from './generator'

/** Builds the ladders (in a Worker when there is one), then hands them to the play view. */
export default function WordLadderView(props: GameViewProps) {
  const [puzzles, setPuzzles] = useState<LadderPuzzle[] | null>(null)
  const { params, seed } = props
  const abort = useRef(props.onAbort)
  abort.current = props.onAbort
  useEffect(() => {
    let cancelled = false
    buildLadders({ params, seed, count: ROUND_COUNTS.word_ladder })
      .then(set => { if (!cancelled) setPuzzles(set) })
      .catch(() => { if (!cancelled) abort.current('The word list could not be loaded.') })
    return () => { cancelled = true }
  }, [params, seed])
  if (!puzzles) return <div className="brain-stage"><p className="brain-hint" role="status">Loading the word list and building the ladders{'…'}</p></div>
  return <WordLadderPlay {...props} puzzles={puzzles} />
}

function WordLadderPlay({ level, params, seed, suspended, onFinish, puzzles }: GameViewProps & { puzzles: LadderPuzzle[] }) {
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [words, setWords] = useState<string[]>([])
  const [hints, setHints] = useState(0)
  const [hintWord, setHintWord] = useState('')
  const [notice, setNotice] = useState('')
  const [shown, setShown] = useState(0)
  const graph = useRef<{ for: LadderPuzzle; graph: LadderGraph } | null>(null)
  const createEngine = useCallback(() => createWordLadderEngine(params, createRng(seed), puzzles), [params, seed, puzzles])
  const block = useTrialBlock<WlTrial, WlResponse>({
    createEngine, maxTrials: ROUND_COUNTS.word_ladder, suspended,
    onFinish: ({ log }) => onFinish(summariseWordLadder(log, level)),
  })
  const { trial, last } = block
  useEffect(() => { input.current?.focus() }, [trial])
  useEffect(() => { if (trial) { setShown(count => count + 1); setText(''); setWords([trial.puzzle.start]); setHints(0); setHintWord(''); setNotice('') } }, [trial])
  const puzzle = trial?.puzzle
  const current = words[words.length - 1] ?? ''
  const hintsLeft = trial ? trial.hints - hints : 0

  const step = (timeStamp: number) => {
    if (!trial || !puzzle || !text) return
    if (text.length !== puzzle.length) { setNotice(`Use a ${puzzle.length}-letter word.`); return }
    if (!oneLetterApart(current, text)) { setNotice(`Change exactly one letter of ${current.toUpperCase()}.`); return }
    if (!puzzle.valid.includes(text)) { setNotice(`"${text}" is not in the word list.`); return }
    if (words.includes(text)) { setNotice(`You already used "${text}".`); return }
    const next = [...words, text]
    setWords(next); setText(''); setNotice(''); setHintWord('')
    if (text === puzzle.goal) block.respond({ words: next, hints, solved: true }, timeStamp)
  }
  const undo = () => { if (words.length > 1) { setWords(list => list.slice(0, -1)); setHintWord(''); setNotice('') } }
  const reset = () => { if (puzzle) { setWords([puzzle.start]); setHintWord(''); setNotice('') } }
  const hint = () => {
    if (!puzzle || hintsLeft <= 0) return
    if (graph.current?.for !== puzzle) graph.current = { for: puzzle, graph: buildLadderGraph(puzzle.common) }
    // A route from where you are, over the common words; if you stepped onto a rare word there may be none from it: use the start.
    const route = shortestPath(graph.current.graph, current, puzzle.goal) ?? shortestPath(graph.current.graph, puzzle.start, puzzle.goal)
    if (!route || route.length < 2) { setNotice('No hint is available from here.'); return }
    setHints(count => count + 1); setHintWord(route[1])
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); step(event.timeStamp) }
    else if (event.key === 'Backspace' && text === '') { event.preventDefault(); event.stopPropagation(); undo() }
  }
  const result = !trial && last ? last : null
  return (
    <div className="brain-stage" onKeyDown={onKeyDown}>
      <div className="brain-status"><span>Puzzle {Math.min(shown, ROUND_COUNTS.word_ladder)} of {ROUND_COUNTS.word_ladder}</span><span>{puzzle ? `par ${puzzle.par} · steps ${Math.max(0, words.length - 1)} · hints left ${hintsLeft}` : ''}</span></div>
      <div className="brain-limitbar">{trial && <div key={shown} style={{ animationDuration: `${trial.limitMs}ms` }} />}</div>
      <div className="brain-arena" style={{ flexDirection: 'column', gap: 8, padding: 12 }}>
        {puzzle && (
          <div className="brain-ladder" aria-label="Ladder">
            <span>{puzzle.start.toUpperCase()}</span>
            {words.slice(1).map((word, i) => <span key={i} className="brain-ladder-step">{word.toUpperCase()}</span>)}
            <span aria-hidden="true">{'↓'}</span>
            <span className="brain-ladder-goal" aria-label="Goal">{puzzle.goal.toUpperCase()}</span>
          </div>
        )}
        {hintWord && <div className="brain-hint" role="status">Try <strong>{hintWord.toUpperCase()}</strong></div>}
        {result && <div className="brain-feedback" role="status" data-ok={String(result.outcome.correct)}>{result.outcome.correct ? 'Reached the goal' : 'Time up'}</div>}
        <div className="brain-feedback" role="status" data-ok="false">{notice || ' '}</div>
      </div>
      <input ref={input} className="brain-answer" autoComplete="off" autoCapitalize="off" spellCheck={false} aria-label="Next word" value={text} disabled={!trial}
        onChange={event => setText(event.target.value.toLowerCase().replace(/[^a-z]/g, ''))} onBlur={() => requestAnimationFrame(() => input.current?.focus())} />
      <ResponsePad buttons={[
        { id: 'step', label: 'Step', hint: 'Enter', onPress: ts => step(ts), disabled: !trial },
        { id: 'undo', label: 'Undo', hint: 'Backspace', onPress: () => undo(), disabled: !trial || words.length < 2 },
        { id: 'reset', label: 'Reset', onPress: () => reset(), disabled: !trial || words.length < 2 },
        { id: 'hint', label: `Hint (${hintsLeft})`, onPress: () => hint(), disabled: !trial || hintsLeft <= 0 },
      ]} />
      <p className="brain-hint">Type a word one letter away from {current ? current.toUpperCase() : 'the last word'} and press Enter. Backspace on an empty box undoes.</p>
    </div>
  )
}

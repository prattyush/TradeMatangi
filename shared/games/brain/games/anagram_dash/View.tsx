import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { BLOCK_SECONDS } from '../../config/difficulty.brain'
import { ResponsePad } from '../../ui/ResponsePad'
import { TimeBar } from '../../ui/TimeBar'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { buildAnagrams } from '../words/host'
import { createAnagramEngine, summariseAnagramDash, type AdResponse, type AdTrial } from './engine'
import type { AnagramPuzzle } from './generator'

const POOL = 80

/** Builds the word pool (in a Worker when there is one), then hands it to the play view. */
export default function AnagramDashView(props: GameViewProps) {
  const [puzzles, setPuzzles] = useState<AnagramPuzzle[] | null>(null)
  const { params, seed } = props
  const abort = useRef(props.onAbort)
  abort.current = props.onAbort
  useEffect(() => {
    let cancelled = false
    buildAnagrams({ params, seed, count: POOL })
      .then(set => { if (!cancelled) setPuzzles(set) })
      .catch(() => { if (!cancelled) abort.current('The word list could not be loaded.') })
    return () => { cancelled = true }
  }, [params, seed])
  if (!puzzles) return <div className="brain-stage"><p className="brain-hint" role="status">Loading the word list{'…'}</p></div>
  return <AnagramDashPlay {...props} puzzles={puzzles} />
}

function AnagramDashPlay({ level, params, seed, suspended, onFinish, puzzles }: GameViewProps & { puzzles: AnagramPuzzle[] }) {
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [notice, setNotice] = useState('')
  const [hintsLeft, setHintsLeft] = useState(Math.round(params.hints))
  const [hinted, setHinted] = useState(false)
  const [misses, setMisses] = useState(0)
  const [order, setOrder] = useState<string[] | null>(null)
  const shuffles = useRef(0)
  const createEngine = useCallback(() => createAnagramEngine(params, createRng(seed), puzzles), [params, seed, puzzles])
  const block = useTrialBlock<AdTrial, AdResponse>({
    createEngine, seconds: BLOCK_SECONDS.anagram_dash, suspended,
    onFinish: ({ log }) => onFinish(summariseAnagramDash(log, level)),
  })
  const { trial, last } = block
  useEffect(() => { input.current?.focus() }, [trial])
  useEffect(() => { if (trial) { setText(''); setNotice(''); setHinted(false); setMisses(0); setOrder(null) } }, [trial])
  const puzzle = trial?.puzzle
  const tiles = order ?? (puzzle ? [...puzzle.letters] : [])
  // Tiles used by what has been typed are dimmed (a letter can be used once).
  const remaining = [...tiles]
  const used = tiles.map(() => false)
  for (const ch of text) { const at = remaining.findIndex((t, i) => t === ch && !used[i]); if (at >= 0) used[at] = true }

  const submit = (timeStamp: number) => {
    if (!trial || text.length === 0) return
    if (text.length !== trial.puzzle.length) { setNotice(`Use all ${trial.puzzle.length} letters.`); return }
    if (trial.puzzle.answers.includes(text)) { block.respond({ word: text, hinted, misses }, timeStamp); return }
    setMisses(count => count + 1); setNotice(`"${text}" is not an accepted word for these letters.`)
  }
  const shuffle = () => {
    if (!puzzle) return
    shuffles.current += 1
    setOrder(createRng(seed + shuffles.current * 7919 + puzzle.target.length).shuffle([...puzzle.letters]))
  }
  const hint = () => {
    if (!trial || hintsLeft <= 0 || hinted) return
    setHintsLeft(count => count - 1); setHinted(true)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); submit(event.timeStamp) }
    else if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); if (trial) block.respond('skip', event.timeStamp) }
  }
  const wasCorrect = last !== null && last.outcome.correct
  return (
    <div className="brain-stage" onKeyDown={onKeyDown}>
      <TimeBar getElapsedMs={block.getElapsedMs} totalMs={BLOCK_SECONDS.anagram_dash * 1000} />
      <div className="brain-status"><span>Hints left: {hintsLeft}</span><span>{puzzle ? `${puzzle.length} letters` : ''}</span></div>
      {trial && <div className="brain-limitbar"><div key={trial.puzzle.letters + trial.puzzle.target} style={{ animationDuration: `${trial.softMs}ms` }} /></div>}
      <div className="brain-arena" style={{ flexDirection: 'column', gap: 12 }}>
        {puzzle && (
          <div className="brain-tiles" aria-label="Letters">
            {tiles.map((letter, i) => <span key={i} className="brain-lettertile" data-used={used[i] ? 'true' : undefined}>{letter.toUpperCase()}</span>)}
          </div>
        )}
        {puzzle && hinted && <div className="brain-hint" role="status">Starts with <strong>{puzzle.target[0].toUpperCase()}</strong></div>}
        {!trial && last && <div className="brain-feedback" role="status" data-ok={String(wasCorrect)}>{wasCorrect ? 'Got it' : last.outcome.tag === 'skip' ? 'Skipped' : 'Time up'}{!wasCorrect ? `: ${last.trial.puzzle.target}` : ''}</div>}
        <div className="brain-feedback" role="status" data-ok="false">{notice || ' '}</div>
      </div>
      <input ref={input} className="brain-answer" autoComplete="off" autoCapitalize="off" spellCheck={false} aria-label="Your word" value={text} disabled={!trial}
        onChange={event => setText(event.target.value.toLowerCase().replace(/[^a-z]/g, ''))} onBlur={() => requestAnimationFrame(() => input.current?.focus())} />
      <ResponsePad buttons={[
        { id: 'enter', label: 'Enter', hint: 'Enter', onPress: ts => submit(ts), disabled: !trial },
        { id: 'shuffle', label: 'Shuffle', onPress: () => shuffle(), disabled: !trial },
        { id: 'hint', label: 'Hint', onPress: () => hint(), disabled: !trial || hintsLeft <= 0 || hinted },
        { id: 'skip', label: 'Skip', hint: 'Tab', onPress: ts => { if (trial) block.respond('skip', ts) }, disabled: !trial },
      ]} />
      <p className="brain-hint">Type a word that uses every letter and press Enter. Tab skips.</p>
    </div>
  )
}


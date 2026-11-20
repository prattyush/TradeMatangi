import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { ROUND_COUNTS } from '../../config/difficulty.brain'
import { PALETTE } from '../../ui/palette'
import { ResponsePad } from '../../ui/ResponsePad'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { buildCodes } from '../reasoning/host'
import { codeScore, createCodeBreakerEngine, summariseCodeBreaker, type CbResponse, type CbTrial } from './engine'
import { feedback, type CodePuzzle } from './solver'

/** Builds the codes (in a Worker when there is one), then hands them to the play view. */
export default function CodeBreakerView(props: GameViewProps) {
  const [codes, setCodes] = useState<CodePuzzle[] | null>(null)
  const { params, seed } = props
  const abort = useRef(props.onAbort)
  abort.current = props.onAbort
  useEffect(() => {
    let cancelled = false
    buildCodes({ params, seed, count: ROUND_COUNTS.code_breaker })
      .then(set => { if (!cancelled) setCodes(set) })
      .catch(() => { if (!cancelled) abort.current('The codes could not be built.') })
    return () => { cancelled = true }
  }, [params, seed])
  if (!codes) return <div className="brain-stage"><p className="brain-hint" role="status">Preparing the codes{'…'}</p></div>
  return <CodeBreakerPlay {...props} codes={codes} />
}

const Symbol = ({ index }: { index: number }) => <span className="brain-symbol-face" style={{ background: PALETTE[index % PALETTE.length].hex }}>{index + 1}</span>

function CodeBreakerPlay({ level, params, seed, suspended, onFinish, codes }: GameViewProps & { codes: CodePuzzle[] }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createCodeBreakerEngine(params, createRng(seed), codes), [params, seed, codes])
  const block = useTrialBlock<CbTrial, CbResponse>({
    createEngine, maxTrials: ROUND_COUNTS.code_breaker, suspended,
    onFinish: ({ log }) => onFinish(summariseCodeBreaker(log, level)),
  })
  const { trial, last } = block
  const [shown, setShown] = useState(0)
  const [current, setCurrent] = useState<number[]>([])
  const [guesses, setGuesses] = useState<number[][]>([])
  useEffect(() => { if (trial) { setShown(count => count + 1); setCurrent([]); setGuesses([]) } }, [trial])

  const place = (symbol: number) => {
    if (!trial || current.length >= trial.length || (!trial.repeats && current.includes(symbol))) return
    setCurrent(list => [...list, symbol])
  }
  const submit = (timeStamp: number) => {
    if (!trial || current.length !== trial.length) return
    const next = [...guesses, current]
    const solved = current.every((s, i) => s === trial.code.secret[i])
    setGuesses(next); setCurrent([])
    if (solved || next.length >= trial.guessLimit) block.respond({ guesses: next, solved }, timeStamp)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat || !trial) return
    if (/^[1-9]$/.test(event.key) && Number(event.key) <= trial.symbols) { event.stopPropagation(); place(Number(event.key) - 1) }
    else if (event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); setCurrent(list => list.slice(0, -1)) }
    else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); submit(event.timeStamp) }
  }
  const hiddenFor = (index: number) => (trial?.code.hidden && trial.code.hidden.guess === index ? trial.code.hidden.value : null)
  const feedbackText = (index: number, guess: number[]) => {
    if (!trial) return ''
    const fb = feedback(trial.code.secret, guess), hide = hiddenFor(index)
    return `${hide === 'exact' ? '?' : fb.exact} exact · ${hide === 'misplaced' ? '?' : fb.misplaced} misplaced`
  }
  const result = !trial && last ? { entry: last, score: codeScore(last) } : null
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <div className="brain-status">
        <span>Code {Math.min(shown, ROUND_COUNTS.code_breaker)} of {ROUND_COUNTS.code_breaker}</span>
        <span>{trial ? `Guess ${Math.min(guesses.length + 1, trial.guessLimit)} of ${trial.guessLimit} · par ${trial.code.par}` : ''}</span>
      </div>
      <div className="brain-arena" style={{ flexDirection: 'column', alignItems: 'stretch', padding: 12, justifyContent: 'flex-start', minHeight: 260 }}>
        {trial && (
          <>
            <div className="brain-history" role="list" aria-label="Guesses so far">
              {guesses.map((guess, i) => (
                <div key={i} className="brain-guessrow" role="listitem">
                  <span style={{ width: 24, color: '#8b949e' }}>{i + 1}</span>
                  {guess.map((s, k) => <Symbol key={k} index={s} />)}
                  <span className="brain-feedbacktext">{feedbackText(i, guess)}</span>
                </div>
              ))}
            </div>
            <div className="brain-guessrow" aria-label="Your guess">
              <span style={{ width: 24 }} />
              {Array.from({ length: trial.length }, (_, i) => (
                <span key={i} className="brain-slot" data-filled={current[i] !== undefined}>{current[i] !== undefined && <Symbol index={current[i]} />}</span>
              ))}
              <span className="brain-feedbacktext" />
            </div>
          </>
        )}
        {result && (
          <div className="brain-feedback" role="status" data-ok={String(result.entry.outcome.correct)}>
            {result.entry.outcome.correct ? `Solved in ${result.score.guesses} guesses (par ${result.entry.trial.code.par})` : `Not solved. The code was ${result.entry.trial.code.secret.map(s => s + 1).join(' ')}`}
          </div>
        )}
      </div>
      <div className="brain-symbols" role="group" aria-label="Symbols">
        {trial && Array.from({ length: trial.symbols }, (_, i) => (
          <button key={i} type="button" tabIndex={-1} className="brain-symbol" style={{ background: PALETTE[i % PALETTE.length].hex }} disabled={!trial.repeats && current.includes(i)} aria-label={`Symbol ${i + 1}`}
            onPointerDown={event => { event.preventDefault(); place(i) }}>{i + 1}</button>
        ))}
      </div>
      <ResponsePad buttons={[
        { id: 'undo', label: 'Undo', hint: 'Backspace', onPress: () => setCurrent(list => list.slice(0, -1)), disabled: !trial },
        { id: 'guess', label: 'Guess', hint: 'Enter', onPress: ts => submit(ts), disabled: !trial || current.length !== trial.length },
      ]} />
      <p className="brain-hint">Place symbols with 1 to {trial?.symbols ?? 8} or click, Backspace undoes, Enter makes the guess. Exact = right symbol, right place.</p>
    </div>
  )
}

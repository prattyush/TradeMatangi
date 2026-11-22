import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { ROUND_COUNTS } from '../../config/difficulty.brain'
import { KeyHint } from '../../ui/KeyHint'
import { PatternDefs, Shape } from '../../ui/Stimulus'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { createCardSorterEngine, REFERENCE_CARDS, summariseCardSorter, type CsCard, type CsResponse, type CsTrial } from './engine'

const SHAPES: Array<'circle' | 'square' | 'triangle' | number> = ['circle', 'square', 'triangle', 5]

export function SortCard({ card, size = 30 }: { card: CsCard; size?: number }) {
  return (
    <span className="brain-sortcard-symbols">
      {Array.from({ length: card.count }, (_, i) => <Shape key={i} shape={SHAPES[card.shape]} colour={card.colour} size={size} />)}
    </span>
  )
}

export default function CardSorterView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createCardSorterEngine(params, createRng(seed)), [params, seed])
  const block = useTrialBlock<CsTrial, CsResponse>({
    createEngine, maxTrials: ROUND_COUNTS.card_sorter, suspended,
    onFinish: ({ log }) => onFinish(summariseCardSorter(log, level)),
  })
  const { trial, last } = block
  // The card count is a display counter only; the block counts judged cards.
  const [shown, setShown] = useState(0)
  useEffect(() => { if (trial) setShown(count => count + 1) }, [trial])
  // Feedback appears after the configured delay (level 15+); the engine's pause after the card is long enough to show it.
  const [feedback, setFeedback] = useState<boolean | null>(null)
  useEffect(() => {
    setFeedback(null)
    if (!last) return
    // Display only (the click's reaction time is already fixed): wait on the frame clock, not a timer.
    const shownAt = performance.now()
    let raf = 0
    const wait = () => {
      if (performance.now() - shownAt >= last.trial.feedbackDelayMs) setFeedback(last.outcome.correct)
      else raf = requestAnimationFrame(wait)
    }
    wait()
    return () => cancelAnimationFrame(raf)
  }, [last])
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat || !/^[1-4]$/.test(event.key)) return
    event.stopPropagation()
    block.respond(Number(event.key) - 1, event.timeStamp)
  }
  const card = (trial ?? last?.trial)?.card
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <PatternDefs />
      <div className="brain-status"><span>Card {Math.min(shown, ROUND_COUNTS.card_sorter)} of {ROUND_COUNTS.card_sorter}</span><span>Find the hidden rule</span></div>
      <div className="brain-refs" role="group" aria-label="Reference cards">
        {REFERENCE_CARDS.map((reference, index) => (
          <button key={index} type="button" tabIndex={-1} className="brain-sortcard" disabled={!trial} aria-label={`Reference card ${index + 1}`}
            onPointerDown={event => { event.preventDefault(); block.respond(index, event.timeStamp) }}>
            <SortCard card={reference} /><KeyHint>{String(index + 1)}</KeyHint>
          </button>
        ))}
      </div>
      <div className="brain-arena" style={{ minHeight: 150, flexDirection: 'column', gap: 8 }}>
        {card && <div className="brain-sortcard brain-sortcard-new" data-dim={trial ? 'false' : 'true'} aria-label="New card"><SortCard card={card} size={40} /></div>}
        <div className="brain-feedback" data-ok={feedback === null ? undefined : String(feedback)} role="status">{feedback === null ? ' ' : feedback ? 'Match' : 'No match'}</div>
      </div>
      <p className="brain-hint">Which reference card does the new card go with? Press 1 to 4 or click. The rule can be colour, shape or number.</p>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { useStagedRounds } from '../../ui/useStagedRounds'
import '../../ui/brain.css'
import { createGridRecallEngine, grRules, summariseGridRecall, type GrResponse, type GrTransform, type GrTrial } from './engine'

const CSS_TRANSFORM: Record<GrTransform, string> = {
  none: '', rot90: 'rotate(90deg)', rot180: 'rotate(180deg)', rot270: 'rotate(270deg)', flipH: 'scaleX(-1)', flipV: 'scaleY(-1)',
}
const TURN_TEXT: Record<GrTransform, string> = {
  none: '', rot90: 'The grid turned 90° clockwise.', rot180: 'The grid turned upside down.', rot270: 'The grid turned 90° anticlockwise.',
  flipH: 'The grid flipped left to right.', flipV: 'The grid flipped top to bottom.',
}

export default function GridRecallView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createGridRecallEngine(params, createRng(seed)), [params, seed])
  const rules = grRules(params)
  const rounds = useStagedRounds<GrTrial, GrResponse>({ createEngine, suspended, onFinish: ({ log }) => onFinish(summariseGridRecall(log, level)) })
  const { trial, stage, progress, last, getStageMs } = rounds
  const [picks, setPicks] = useState<number[]>([])
  const [lit, setLit] = useState<Set<number>>(new Set())
  const [turned, setTurned] = useState(false)
  useEffect(() => { setPicks([]); setLit(new Set()); setTurned(false) }, [trial])

  // Light the tiles from the frame clock: one by one, or all together.
  useEffect(() => {
    if (!trial || stage !== 'show') { setLit(current => (current.size ? new Set() : current)); return }
    let raf = 0
    const tick = () => {
      const ms = getStageMs()
      let next: number[] = []
      if (trial.mode === 1) next = ms < trial.simultaneousMs ? trial.sequence : []
      else {
        const slot = trial.flashMs + trial.gapMs
        const index = Math.floor(ms / slot)
        if (index < trial.span && ms - index * slot < trial.flashMs) next = [trial.sequence[index]]
      }
      setLit(current => (current.size === next.length && next.every(t => current.has(t)) ? current : new Set(next)))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [trial, stage, getStageMs])
  useEffect(() => { if (stage === 'turn') requestAnimationFrame(() => setTurned(true)) }, [stage])

  const pick = (tile: number) => {
    if (!trial || stage !== 'respond' || picks.includes(tile)) return
    const next = [...picks, tile]
    setPicks(next)
    if (next.length === trial.span) rounds.submit(next)
  }
  const n = trial?.gridN ?? rules.gridN
  const transform = trial && (stage === 'respond' || (stage === 'turn' && turned)) ? CSS_TRANSFORM[trial.transform] : ''
  const prompt = !trial ? '' : stage === 'respond'
    ? `${trial.transform !== 'none' ? TURN_TEXT[trial.transform] + ' ' : ''}${trial.mode === 1 ? 'Tap every tile that lit up.' : trial.mode === 2 ? 'Tap the tiles in REVERSE order.' : 'Tap the tiles in the same order.'}`
    : stage === 'turn' ? TURN_TEXT[trial.transform] : stage === 'show' ? 'Watch…' : 'Get ready…'
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onBlur={() => root.current?.focus()}>
      <div className="brain-status">
        <span>{progress ? `Span ${progress.span} · Round ${Math.min((progress.trial ?? 0) + 1, progress.of ?? 0)} of up to ${progress.of}` : `Span ${rules.startSpan}`}</span>
        <span>Strikes {progress?.strikes ?? 0} of 3</span>
      </div>
      <div className="brain-grid" style={{ gridTemplateColumns: `repeat(${n}, 1fr)`, transform }} aria-label="Memory grid">
        {Array.from({ length: n * n }, (_, tile) => (
          <button key={tile} type="button" tabIndex={-1} className="brain-tile" data-lit={lit.has(tile)} data-picked={picks.includes(tile)}
            aria-label={`Tile ${tile + 1}`} onPointerDown={event => { event.preventDefault(); pick(tile) }} />
        ))}
      </div>
      <p className="brain-hint">{prompt}</p>
      <p className="brain-feedback" role="status" data-ok={last ? last.outcome.correct : undefined}>{last ? (last.outcome.correct ? 'Correct' : 'Not quite') : ''}</p>
    </div>
  )
}


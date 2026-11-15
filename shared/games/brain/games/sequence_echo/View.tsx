import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { PALETTE } from '../../ui/palette'
import { PatternDefs, Swatch } from '../../ui/Stimulus'
import { useStagedRounds } from '../../ui/useStagedRounds'
import '../../ui/brain.css'
import { createSequenceEchoEngine, seLabel, summariseSequenceEcho, type SeResponse, type SeTrial } from './engine'

export default function SequenceEchoView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createSequenceEchoEngine(params, createRng(seed)), [params, seed])
  const rounds = useStagedRounds<SeTrial, SeResponse>({ createEngine, suspended, onFinish: ({ log }) => onFinish(summariseSequenceEcho(log, level)) })
  const { trial, stage, progress, last, getStageMs } = rounds
  const kind = (trial?.kind ?? Math.round(params.kind)) as 0 | 1 | 2
  const items = trial?.items ?? Math.round(params.items)
  const [picks, setPicks] = useState<number[]>([])
  const [showing, setShowing] = useState<{ item: number; distractor: boolean } | null>(null)
  useEffect(() => { setPicks([]); setShowing(null) }, [trial])

  useEffect(() => {
    if (!trial || stage !== 'show') { setShowing(null); return }
    let raf = 0
    const tick = () => {
      const ms = getStageMs()
      const slot = trial.itemMs + trial.gapMs
      const index = Math.floor(ms / slot)
      const event = index < trial.events.length && ms - index * slot < trial.itemMs ? trial.events[index] : null
      setShowing(current => (current?.item === event?.item && current?.distractor === event?.distractor ? current : event))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [trial, stage, getStageMs])

  const press = (item: number) => {
    if (!trial || stage !== 'respond') return
    const next = [...picks, item]
    setPicks(next)
    if (next.length === trial.span) rounds.submit(next)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat || !trial || stage !== 'respond') return
    if (event.key === 'Backspace') { event.stopPropagation(); setPicks(current => current.slice(0, -1)); return }
    const item = kind === 2 ? event.key.toUpperCase().charCodeAt(0) - 65 : Number(event.key) - 1
    if (event.key.length === 1 && Number.isInteger(item) && item >= 0 && item < items) { event.stopPropagation(); press(item) }
  }
  const face = (item: number) => (kind === 0 ? <Swatch colour={item} size={48} /> : <span>{seLabel(kind, item)}</span>)
  const prompt = !trial ? '' : stage === 'respond' ? (trial.backward ? 'Enter the sequence BACKWARDS.' : 'Enter the sequence in the same order.') : stage === 'show' ? 'Watch…' : 'Get ready…'
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <PatternDefs />
      <div className="brain-status">
        <span>{progress ? `Span ${progress.span} · Round ${Math.min((progress.trial ?? 0) + 1, progress.of ?? 0)} of up to ${progress.of}` : `Span ${Math.round(params.startSpan)}`}</span>
        <span>Strikes {progress?.strikes ?? 0} of 3</span>
      </div>
      <div className="brain-padset" aria-label="Items">
        {Array.from({ length: items }, (_, item) => (
          <button key={item} type="button" tabIndex={-1} className="brain-item" data-lit={showing?.item === item && !showing.distractor}
            data-distractor={showing?.item === item && showing.distractor} aria-label={`Item ${seLabel(kind, item)}`}
            onPointerDown={event => { event.preventDefault(); press(item) }}>{face(item)}</button>
        ))}
      </div>
      <div className="brain-picks" aria-label="Your answer">{picks.map((item, i) => <span key={i}>{kind === 0 ? PALETTE[item].name.toLowerCase() : seLabel(kind, item)}</span>)}</div>
      <p className="brain-hint">{prompt}{trial && stage === 'respond' ? ' Click, or press the key shown (Backspace undoes).' : ''}{trial?.events.some(e => e.distractor) && stage === 'show' ? ' Ignore the grey dashed flashes.' : ''}</p>
      <p className="brain-feedback" role="status" data-ok={last ? last.outcome.correct : undefined}>{last ? (last.outcome.correct ? 'Correct' : 'Not quite') : ''}</p>
    </div>
  )
}

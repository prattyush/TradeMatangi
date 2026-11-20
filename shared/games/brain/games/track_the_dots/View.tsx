import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { ROUND_COUNTS } from '../../config/difficulty.brain'
import { useStagedRounds } from '../../ui/useStagedRounds'
import '../../ui/brain.css'
import { ARENA_H, ARENA_W, createTrackDotsEngine, dotAt, DOT_RADIUS, OCCLUDER, stepAtMs, summariseTrackDots, type TdResponse, type TdTrial } from './engine'

const DOT = '#D0D7DE', TARGET = '#E69F00', PICKED = '#56B4E9'

function draw(ctx: CanvasRenderingContext2D, trial: TdTrial | null, stage: string | null, ms: number, picked: Set<number>) {
  ctx.clearRect(0, 0, ARENA_W, ARENA_H)
  if (!trial || !stage) return
  const step = stage === 'mark' ? 0 : stage === 'move' ? stepAtMs(ms) : trial.steps
  const targets = new Set(trial.targets)
  const flicker = stage === 'move' ? new Set(trial.flicker.filter(f => ms >= f.atMs && ms < f.atMs + f.durMs).flatMap(f => f.dots)) : new Set<number>()
  for (let d = 0; d < trial.dots; d++) {
    const { x, y } = dotAt(trial, step, d)
    const marked = stage === 'mark' && targets.has(d)
    // Marked dots carry a ring as well as a colour, so the cue is not colour alone.
    ctx.beginPath(); ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = picked.has(d) ? PICKED : marked ? TARGET : flicker.has(d) ? '#ffffff' : DOT
    ctx.fill()
    if (marked || picked.has(d)) { ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke() }
  }
  if (trial.occluder && stage === 'move') {
    ctx.fillStyle = 'rgba(33,38,45,0.92)'; ctx.fillRect(OCCLUDER.x, OCCLUDER.y, OCCLUDER.w, OCCLUDER.h)
    ctx.strokeStyle = '#484f58'; ctx.lineWidth = 2; ctx.strokeRect(OCCLUDER.x, OCCLUDER.y, OCCLUDER.w, OCCLUDER.h)
  }
}

export default function TrackDotsView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createTrackDotsEngine(params, createRng(seed)), [params, seed])
  const rounds = useStagedRounds<TdTrial, TdResponse>({ createEngine, suspended, maxTrials: ROUND_COUNTS.track_the_dots, onFinish: ({ log }) => onFinish(summariseTrackDots(log, level)) })
  const { trial, stage, progress, last, getStageMs } = rounds
  const [picked, setPicked] = useState<number[]>([])
  useEffect(() => { setPicked([]) }, [trial])
  const pickedSet = new Set(picked)

  // Animate from the frame clock while the dots are shown or moving; redraw on a pick while answering.
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    if (stage === 'mark' || stage === 'move') {
      let raf = 0
      const tick = () => { draw(ctx, trial, stage, getStageMs(), new Set()); raf = requestAnimationFrame(tick) }
      raf = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(raf)
    }
    draw(ctx, trial, stage, 0, pickedSet)
  }, [trial, stage, getStageMs, picked]) // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    if (!trial || stage !== 'respond') return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * ARENA_W, y = ((event.clientY - rect.top) / rect.height) * ARENA_H
    let best = -1, bestDistance = DOT_RADIUS * 1.8
    for (let d = 0; d < trial.dots; d++) {
      const p = dotAt(trial, trial.steps, d)
      const distance = Math.hypot(p.x - x, p.y - y)
      if (distance < bestDistance) { best = d; bestDistance = distance }
    }
    if (best < 0) return
    const next = pickedSet.has(best) ? picked.filter(d => d !== best) : [...picked, best]
    setPicked(next)
    if (next.length === trial.targets.length) rounds.submit(next)
  }
  const wanted = trial?.targets.length ?? Math.round(params.targets)
  const prompt = !trial ? '' : stage === 'mark' ? 'Remember the orange dots…' : stage === 'move' ? 'Keep your eyes on them…' : `Click the ${wanted} dots you were following (${picked.length} of ${wanted}). Click again to undo.`
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onBlur={() => root.current?.focus()}>
      <div className="brain-status"><span>Trial {Math.min((progress?.trial ?? 0) + 1, ROUND_COUNTS.track_the_dots)} of {ROUND_COUNTS.track_the_dots}</span><span>{Math.round(params.dots)} dots · follow {Math.round(params.targets)}</span></div>
      <canvas ref={canvas} className="brain-canvas" width={ARENA_W} height={ARENA_H} onPointerDown={onPointerDown} aria-label="Dots arena" />
      <p className="brain-hint">{prompt}</p>
      <p className="brain-feedback" role="status" data-ok={last ? last.outcome.correct : undefined}>{last ? (last.outcome.correct ? 'All right' : `You found ${last.outcome.tag?.split('/')[0]} of ${wanted}`) : ''}</p>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { BLOCK_SECONDS } from '../../config/difficulty.brain'
import { parseTyped } from '../../engine/arithmetic'
import { TimeBar } from '../../ui/TimeBar'
import '../../ui/brain.css'
import { createDropSim, LIVES, summariseEquationDrop, type DropSim, type LiveDrop } from './engine'

const MAX_STEP_MS = 100
const ARENA_HEIGHT = 340

/**
 * Real-time view: a rAF loop steps the pure `DropSim` with the frame time. Frames longer than 100 ms are clamped (the drops
 * never jump), and losing focus or an open quit dialog pauses the clock (the shell voids the block after 10 s away).
 */
export default function EquationDropView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [snapshot, setSnapshot] = useState<{ drops: LiveDrop[]; lives: number; combo: number; locked: boolean }>({ drops: [], lives: LIVES, combo: 0, locked: false })
  const [flash, setFlash] = useState<string | null>(null)
  const sim = useRef<DropSim | null>(null)
  const clock = useRef(0)
  const latest = useRef({ suspended, onFinish, level })
  latest.current = { suspended, onFinish, level }
  const textRef = useRef(text)
  textRef.current = text

  useEffect(() => {
    const world = createDropSim(params, createRng(seed))
    sim.current = world
    clock.current = 0
    let raf = 0, last = -1, stopped = false, blurred = false
    const onBlur = () => { blurred = true }
    const onFocus = () => { blurred = false }
    window.addEventListener('blur', onBlur); window.addEventListener('focus', onFocus)
    const frame = (ts: number) => {
      if (stopped) return
      const away = latest.current.suspended || document.hidden || blurred
      if (last < 0 || away) last = ts
      else {
        world.step(Math.min(MAX_STEP_MS, ts - last))
        last = ts
      }
      clock.current = world.elapsedMs
      setSnapshot({ drops: world.drops, lives: world.lives, combo: world.combo, locked: world.locked })
      if (world.over) { stopped = true; latest.current.onFinish(summariseEquationDrop(world.log, latest.current.level)); return }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    input.current?.focus()
    return () => { stopped = true; cancelAnimationFrame(raf); window.removeEventListener('blur', onBlur); window.removeEventListener('focus', onFocus) }
  }, [params, seed])

  const submit = () => {
    const world = sim.current
    const value = parseTyped(textRef.current)
    if (!world || value === null) return
    const cleared = world.submit(value)
    setText('')
    setFlash(cleared.length > 1 ? `${cleared.length} cleared! combo ${world.combo}` : cleared.length === 1 ? (world.combo > 1 ? `combo ${world.combo}` : 'cleared') : 'no match')
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); submit() }
  }
  return (
    <div className="brain-stage" onKeyDown={onKeyDown}>
      <TimeBar getElapsedMs={() => clock.current} totalMs={BLOCK_SECONDS.equation_drop * 1000} />
      <div className="brain-status"><span aria-label={`${snapshot.lives} lives left`}>{'♥'.repeat(snapshot.lives)}{'♡'.repeat(LIVES - snapshot.lives)}</span><span>Combo {snapshot.combo}</span></div>
      <div className="brain-dropfield" style={{ height: ARENA_HEIGHT }} role="group" aria-label="Falling equations">
        {snapshot.drops.map(({ trial, y }) => (
          <div key={trial.id} className="brain-drop" data-reverse={trial.reverse ? 'true' : undefined} style={{ left: `${trial.lane * 100}%`, top: y * (ARENA_HEIGHT - 44) }}>
            {trial.text}{trial.reverse ? '' : ' = ?'}
          </div>
        ))}
        <div className="brain-dropline" aria-hidden="true" />
      </div>
      <div className="brain-feedback" role="status" data-ok={flash === 'no match' ? 'false' : 'true'}>{flash ?? ' '}</div>
      <input ref={input} className="brain-answer" inputMode="numeric" autoComplete="off" aria-label="Your answer" value={text} data-locked={snapshot.locked ? 'true' : undefined}
        onChange={event => setText(event.target.value.replace(/[^0-9\-−]/g, ''))} onBlur={() => requestAnimationFrame(() => input.current?.focus())} />
      <p className="brain-hint">Type an answer and press Enter: every equation with that answer clears. Reversed ones ("? + 9 = 23") ask for the missing number.</p>
    </div>
  )
}

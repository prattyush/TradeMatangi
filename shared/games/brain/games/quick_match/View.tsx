import { useCallback, useEffect, useRef } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { BLOCK_SECONDS } from '../../config/difficulty.brain'
import { PALETTE } from '../../ui/palette'
import { ResponsePad } from '../../ui/ResponsePad'
import { PatternDefs, Shape } from '../../ui/Stimulus'
import { TimeBar } from '../../ui/TimeBar'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { createQuickMatchEngine, summariseQuickMatch, type QmItem, type QmResponse, type QmTrial } from './engine'

const item = (it: QmItem) => <Shape shape={it.shape} colour={it.colour} scale={it.scale} rotation={it.rotation} mirrored={it.mirrored}
  label={`${PALETTE[it.colour].name.toLowerCase()} shape`} />

export default function QuickMatchView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createQuickMatchEngine(params, createRng(seed)), [params, seed])
  const block = useTrialBlock<QmTrial, QmResponse>({
    createEngine, seconds: BLOCK_SECONDS.quick_match, suspended,
    onFinish: ({ log }) => onFinish(summariseQuickMatch(log, level)),
  })
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    const key = event.key.toLowerCase()
    if (key === 's') { event.stopPropagation(); block.respond('same', event.timeStamp) }
    else if (key === 'd') { event.stopPropagation(); block.respond('different', event.timeStamp) }
  }
  const { trial } = block
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <PatternDefs />
      <TimeBar getElapsedMs={block.getElapsedMs} totalMs={BLOCK_SECONDS.quick_match * 1000} />
      <div className="brain-arena" data-vertical={trial?.vertical ?? false} aria-live="off">
        {trial && (block.visible ? <>{item(trial.left)}{item(trial.right)}</> : <span className="games-meta">Same or different?</span>)}
      </div>
      <ResponsePad buttons={[
        { id: 'same', label: 'Same', hint: 'S', onPress: ts => block.respond('same', ts) },
        { id: 'different', label: 'Different', hint: 'D', onPress: ts => block.respond('different', ts) },
      ]} />
      <p className="brain-hint">Press S for same, D for different. Be fast, but not careless.</p>
    </div>
  )
}

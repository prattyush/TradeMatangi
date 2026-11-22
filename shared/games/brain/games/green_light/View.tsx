import { useCallback, useEffect, useRef } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { BLOCK_SECONDS } from '../../config/difficulty.brain'
import { ResponsePad } from '../../ui/ResponsePad'
import { PatternDefs, Shape } from '../../ui/Stimulus'
import { TimeBar } from '../../ui/TimeBar'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { createGreenLightEngine, summariseGreenLight, type GlResponse, type GlTrial } from './engine'

export default function GreenLightView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createGreenLightEngine(params, createRng(seed)), [params, seed])
  const block = useTrialBlock<GlTrial, GlResponse>({
    createEngine, seconds: BLOCK_SECONDS.green_light, suspended,
    banner: trial => trial.banner,
    onFinish: ({ log }) => onFinish(summariseGreenLight(log, level)),
  })
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.code !== 'Space') return
    event.preventDefault(); event.stopPropagation()
    if (!event.repeat) block.respond('press', event.timeStamp)
  }
  const { trial } = block
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <PatternDefs />
      <TimeBar getElapsedMs={block.getElapsedMs} totalMs={BLOCK_SECONDS.green_light * 1000} />
      <div className="brain-arena">
        {block.banner && <div className="brain-banner" role="status">{block.banner}</div>}
        {trial && block.visible && <Shape shape={trial.shape} colour={trial.colour} size={120} label={`${trial.shape}`} />}
      </div>
      <ResponsePad buttons={[{ id: 'go', label: 'GO', hint: 'Space', onPress: ts => block.respond('press', ts) }]} />
      <p className="brain-hint">Press Space (or GO) for a GO symbol. Do nothing for the others.</p>
    </div>
  )
}

import { useCallback, useEffect, useRef } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { BLOCK_SECONDS } from '../../config/difficulty.brain'
import { PALETTE } from '../../ui/palette'
import { ResponsePad } from '../../ui/ResponsePad'
import { PatternDefs, Swatch } from '../../ui/Stimulus'
import { TimeBar } from '../../ui/TimeBar'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { createColourClashEngine, summariseColourClash, type CcResponse, type CcTrial } from './engine'

export default function ColourClashView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createColourClashEngine(params, createRng(seed)), [params, seed])
  const block = useTrialBlock<CcTrial, CcResponse>({
    createEngine, seconds: BLOCK_SECONDS.colour_clash, suspended,
    onFinish: ({ log }) => onFinish(summariseColourClash(log, level)),
  })
  const { trial } = block
  const order = trial?.order ?? Array.from({ length: Math.round(params.colours) }, (_, i) => i)
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat || !trial) return
    const position = Number(event.key) - 1
    if (Number.isInteger(position) && position >= 0 && position < trial.order.length) { event.stopPropagation(); block.respond(trial.order[position], event.timeStamp) }
  }
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <PatternDefs />
      <TimeBar getElapsedMs={block.getElapsedMs} totalMs={BLOCK_SECONDS.colour_clash * 1000} />
      <div className="brain-arena">
        {trial && (
          <span className="brain-word" style={{ color: PALETTE[trial.ink].hex }} aria-label="colour word">
            {trial.word === null ? 'XXXX' : PALETTE[trial.word].name}
          </span>
        )}
      </div>
      <ResponsePad buttons={order.map((colour, position) => ({
        id: `c${position}`, hint: String(position + 1),
        label: <><Swatch colour={colour} /><span>{PALETTE[colour].name}</span></>,
        onPress: ts => trial && block.respond(colour, ts),
      }))} />
      <p className="brain-hint">Pick the colour the word is printed in, not what it says. Keys 1 to {order.length}, or click.</p>
    </div>
  )
}

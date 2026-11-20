import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { BLOCK_SECONDS } from '../../config/difficulty.brain'
import { ResponsePad } from '../../ui/ResponsePad'
import { TimeBar } from '../../ui/TimeBar'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { bannerText, createFlipMapEngine, GLYPH, RULE_TEXT, summariseFlipMap, type FmDir, type FmResponse, type FmRule, type FmTrial } from './engine'

const KEYS: Record<string, FmDir> = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left' }

export default function FlipMapView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createFlipMapEngine(params, createRng(seed)), [params, seed])
  const block = useTrialBlock<FmTrial, FmResponse>({
    createEngine, seconds: BLOCK_SECONDS.flip_map, suspended, banner: bannerText,
    onFinish: ({ log }) => onFinish(summariseFlipMap(log, level)),
  })
  const { trial, visible, last } = block
  // Mode 0 keeps the rule on screen: remember the rule of the latest arrow.
  const [rule, setRule] = useState<FmRule | null>(null)
  useEffect(() => { if (trial) setRule(trial.rule) }, [trial])
  const onKeyDown = (event: React.KeyboardEvent) => {
    const dir = KEYS[event.key]
    if (event.repeat || !dir) return
    event.preventDefault(); event.stopPropagation()
    block.respond(dir, event.timeStamp)
  }
  const bannerMode = (trial ?? last?.trial)?.bannerMode ?? Math.round(params.banner)
  // From level 13 the only sign of a changed rule is a brief red flash after a mistake.
  const flash = bannerMode === 2 && last !== null && !last.outcome.correct
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <TimeBar getElapsedMs={block.getElapsedMs} totalMs={BLOCK_SECONDS.flip_map * 1000} />
      {bannerMode === 0 && <div className="brain-rule" role="status">{rule ? RULE_TEXT[rule] : ' '}</div>}
      <div className="brain-arena" style={{ flexDirection: 'column' }} data-flash={flash ? 'true' : undefined}>
        {block.banner && <div className="brain-banner" role="status">{block.banner}</div>}
        {trial && visible && <div className="brain-bigarrow" aria-label={`arrow ${trial.dir}`}>{GLYPH[trial.dir]}</div>}
      </div>
      <ResponsePad buttons={(['up', 'right', 'down', 'left'] as FmDir[]).map(dir => ({ id: dir, label: GLYPH[dir], hint: GLYPH[dir], onPress: ts => block.respond(dir, ts) }))} />
      <p className="brain-hint">Press the arrow key the current rule asks for. The rule changes every few arrows.</p>
    </div>
  )
}

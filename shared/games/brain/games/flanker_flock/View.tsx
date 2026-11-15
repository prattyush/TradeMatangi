import { useCallback, useEffect, useRef } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { BLOCK_SECONDS } from '../../config/difficulty.brain'
import { ResponsePad } from '../../ui/ResponsePad'
import { TimeBar } from '../../ui/TimeBar'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { createFlankerEngine, cueText, summariseFlanker, type FlResponse, type FlSymbol, type FlTrial } from './engine'

const glyph = (symbol: FlSymbol) => (symbol === 'left' ? '←' : symbol === 'right' ? '→' : '–')

export default function FlankerView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createFlankerEngine(params, createRng(seed)), [params, seed])
  const block = useTrialBlock<FlTrial, FlResponse>({
    createEngine, seconds: BLOCK_SECONDS.flanker_flock, suspended, banner: cueText,
    onFinish: ({ log }) => onFinish(summariseFlanker(log, level)),
  })
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); block.respond('left', event.timeStamp) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); block.respond('right', event.timeStamp) }
  }
  const { trial, visible } = block
  const rows = trial ? (trial.decoy ? (trial.targetRow === 0 ? [trial.row, trial.decoy] : [trial.decoy, trial.row]) : [trial.row]) : []
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <TimeBar getElapsedMs={block.getElapsedMs} totalMs={BLOCK_SECONDS.flanker_flock * 1000} />
      <div className="brain-arena" style={{ flexDirection: 'column', gap: 10 }}>
        {block.banner && <div className="brain-banner" role="status">{block.banner}</div>}
        {trial && visible && (
          <div style={{ transform: `translateY(${trial.offsetY}px)`, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((row, i) => (
              <div key={i} className="brain-arrows" data-row={row === trial.row ? 'target' : 'decoy'} aria-label={row === trial.row ? 'target row' : 'decoy row'}>{row.map(glyph).join(' ')}</div>
            ))}
          </div>
        )}
      </div>
      <ResponsePad buttons={[
        { id: 'left', label: '← Left', hint: '←', onPress: ts => block.respond('left', ts) },
        { id: 'right', label: 'Right →', hint: '→', onPress: ts => block.respond('right', ts) },
      ]} />
      <p className="brain-hint">Which way does the MIDDLE arrow point? Ignore the others. Use the arrow keys or the buttons.</p>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { ROUND_COUNTS } from '../../config/difficulty.brain'
import { ResponsePad } from '../../ui/ResponsePad'
import { PatternDefs, patternFill } from '../../ui/Stimulus'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { createNeedleEngine, NF_HEIGHT, NF_WIDTH, summariseNeedleFinder, type NfResponse, type NfTrial } from './engine'

const PREFIX = 'brain-sm'

export default function NeedleFinderView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createNeedleEngine(params, createRng(seed)), [params, seed])
  const block = useTrialBlock<NfTrial, NfResponse>({
    createEngine, maxTrials: ROUND_COUNTS.needle_finder, suspended,
    onFinish: ({ log }) => onFinish(summariseNeedleFinder(log, level)),
  })
  const { trial } = block
  // Trial counter and the visual countdown bar only; the real limit is kept by the block.
  const [shown, setShown] = useState(0)
  useEffect(() => { if (trial) setShown(count => count + 1) }, [trial])
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!event.repeat && event.key.toLowerCase() === 'n') { event.stopPropagation(); block.respond({ type: 'absent' }, event.timeStamp) }
  }
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <PatternDefs scale={0.22} prefix={PREFIX} />
      <div className="brain-status"><span>Trial {Math.min(shown, ROUND_COUNTS.needle_finder)} of {ROUND_COUNTS.needle_finder}</span><span>Find the red upright bar</span></div>
      <div className="brain-limitbar">{trial && <div key={shown} style={{ animationDuration: `${trial.limitMs}ms` }} />}</div>
      <div className="brain-arena" style={{ padding: 8 }}>
        {trial && (
          <svg viewBox={`0 0 ${NF_WIDTH} ${NF_HEIGHT}`} width="100%" role="group" aria-label="Search display" style={{ maxHeight: 380 }}>
            {trial.items.map((item, index) => {
              const w = item.orient === 'v' ? 2.6 : 7.4, h = item.orient === 'v' ? 7.4 : 2.6
              return (
                <rect key={index} x={item.x - w / 2} y={item.y - h / 2} width={w} height={h} rx={0.5} fill={patternFill(item.colour, PREFIX)} stroke="#D0D7DE" strokeWidth={0.25}
                  style={{ cursor: 'pointer' }} onPointerDown={event => { event.preventDefault(); block.respond({ type: 'click', index }, event.timeStamp) }} />
              )
            })}
          </svg>
        )}
      </div>
      <ResponsePad buttons={[{ id: 'absent', label: 'Not there', hint: 'N', onPress: ts => block.respond({ type: 'absent' }, ts) }]} />
      <p className="brain-hint">Click the red upright bar, or press N if it is not on the screen. 20% to 30% of screens have none.</p>
    </div>
  )
}

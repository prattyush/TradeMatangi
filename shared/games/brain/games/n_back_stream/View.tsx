import { useCallback, useEffect, useRef } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { BLOCK_SECONDS } from '../../config/difficulty.brain'
import { ResponsePad } from '../../ui/ResponsePad'
import { TimeBar } from '../../ui/TimeBar'
import { useTrialBlock, type TrialInput } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { createNBackEngine, NB_LETTERS, summariseNBack, type NbPress, type NbResponse, type NbTrial } from './engine'

/** The earliest press of each key during the item is what counts. */
const combine = (events: TrialInput<NbPress>[]): NbResponse => ({
  letter: events.find(e => e.input === 'letter')?.rtMs ?? null,
  pos: events.find(e => e.input === 'pos')?.rtMs ?? null,
})

export default function NBackView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createNBackEngine(params, createRng(seed)), [params, seed])
  const block = useTrialBlock<NbTrial, NbResponse, NbPress>({
    createEngine, seconds: BLOCK_SECONDS.n_back_stream, suspended, combine,
    onFinish: ({ log }) => onFinish(summariseNBack(log, level)),
  })
  const n = Math.round(params.n), dual = params.dual >= 1
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    const key = event.key.toLowerCase()
    if (dual ? key === 'l' : key === 'm') { event.stopPropagation(); block.respond('letter', event.timeStamp) }
    else if (dual && key === 'a') { event.stopPropagation(); block.respond('pos', event.timeStamp) }
  }
  const { trial, visible } = block
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <TimeBar getElapsedMs={block.getElapsedMs} totalMs={BLOCK_SECONDS.n_back_stream * 1000} />
      <div className="brain-arena">
        {trial && visible && (dual
          ? <div className="brain-nback-grid">{Array.from({ length: 9 }, (_, cell) => <div key={cell}>{cell === trial.pos ? NB_LETTERS[trial.letter] : ''}</div>)}</div>
          : <span className="brain-letter">{NB_LETTERS[trial.letter]}</span>)}
      </div>
      <ResponsePad buttons={dual
        ? [{ id: 'pos', label: 'Same place', hint: 'A', onPress: ts => block.respond('pos', ts) }, { id: 'letter', label: 'Same letter', hint: 'L', onPress: ts => block.respond('letter', ts) }]
        : [{ id: 'match', label: 'Match', hint: 'M', onPress: ts => block.respond('letter', ts) }]} />
      <p className="brain-hint">{dual ? `Press A if the place is the same as ${n} back, L if the letter is. Both can be true.` : `Press M when the letter is the same as the one ${n} back.`} The first {n} {n === 1 ? 'item' : 'items'} are just for remembering.</p>
    </div>
  )
}

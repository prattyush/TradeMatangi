import { useCallback, useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { BLOCK_SECONDS } from '../../config/difficulty.brain'
import { formatNumber, parseTyped } from '../../engine/arithmetic'
import { ResponsePad } from '../../ui/ResponsePad'
import { TimeBar } from '../../ui/TimeBar'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { createNumberSprintEngine, summariseNumberSprint, type NsResponse, type NsTrial } from './engine'

export default function NumberSprintView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const createEngine = useCallback(() => createNumberSprintEngine(params, createRng(seed)), [params, seed])
  const block = useTrialBlock<NsTrial, NsResponse>({
    createEngine, seconds: BLOCK_SECONDS.number_sprint, suspended,
    onFinish: ({ log }) => onFinish(summariseNumberSprint(log, level)),
  })
  const { trial, last } = block
  useEffect(() => { input.current?.focus() }, [trial])
  useEffect(() => { if (trial) setText('') }, [trial])
  const submit = (timeStamp: number) => {
    const value = parseTyped(text)
    if (value === null) return
    block.respond(value, timeStamp)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); submit(event.timeStamp) }
    else if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); block.respond('skip', event.timeStamp) }
  }
  const wrong = last !== null && !last.outcome.correct
  return (
    <div className="brain-stage" onKeyDown={onKeyDown}>
      <TimeBar getElapsedMs={block.getElapsedMs} totalMs={BLOCK_SECONDS.number_sprint * 1000} />
      <div className="brain-arena" style={{ flexDirection: 'column', gap: 10 }}>
        {trial && <div className="brain-problem" aria-label="problem">{trial.problem.text}</div>}
        {!trial && wrong && last && (
          <div className="brain-feedback" data-ok="false" role="status" aria-label="correct answer">
            <div className="brain-problem" style={{ fontSize: '2em' }}>{last.trial.problem.text} = {formatNumber(last.trial.problem.answer)}</div>
          </div>
        )}
      </div>
      <input ref={input} className="brain-answer" inputMode="decimal" autoComplete="off" aria-label="Your answer" value={text} disabled={!trial}
        onChange={event => setText(event.target.value.replace(/[^0-9.\-−]/g, ''))} onBlur={() => requestAnimationFrame(() => input.current?.focus())} />
      <ResponsePad buttons={[
        { id: 'enter', label: 'Enter answer', hint: 'Enter', onPress: ts => submit(ts), disabled: !trial },
        { id: 'skip', label: 'Skip', hint: 'Tab', onPress: ts => block.respond('skip', ts), disabled: !trial },
      ]} />
      <p className="brain-hint">Type the answer, press Enter. Tab skips a problem. Wrong answers cost half a point.</p>
    </div>
  )
}

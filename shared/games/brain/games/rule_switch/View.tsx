import { useCallback, useEffect, useRef } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { BLOCK_SECONDS } from '../../config/difficulty.brain'
import { colourAt } from '../../ui/palette'
import { ResponsePad } from '../../ui/ResponsePad'
import { TimeBar } from '../../ui/TimeBar'
import { useTrialBlock } from '../../ui/useTrialBlock'
import '../../ui/brain.css'
import { createRuleSwitchEngine, cueLine, cueText, RULE_LABEL, summariseRuleSwitch, type RsKey, type RsResponse, type RsTrial } from './engine'

export default function RuleSwitchView({ level, params, seed, suspended, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.focus() }, [])
  const createEngine = useCallback(() => createRuleSwitchEngine(params, createRng(seed)), [params, seed])
  const block = useTrialBlock<RsTrial, RsResponse>({
    createEngine, seconds: BLOCK_SECONDS.rule_switch, suspended, banner: cueText,
    onFinish: ({ log }) => onFinish(summariseRuleSwitch(log, level)),
  })
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    const key = event.key.toUpperCase()
    if (key === 'F' || key === 'J') { event.stopPropagation(); block.respond(key as RsKey, event.timeStamp) }
  }
  const { trial, visible } = block
  const label = trial ? RULE_LABEL[trial.rule] : null
  return (
    <div ref={root} className="brain-stage" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <TimeBar getElapsedMs={block.getElapsedMs} totalMs={BLOCK_SECONDS.rule_switch * 1000} />
      <div className="brain-arena" style={{ flexDirection: 'column', gap: 10 }}>
        {block.banner && <div className="brain-banner" role="status">{block.banner}</div>}
        {trial && visible && label && (
          <div className="brain-card" data-rule={trial.rule} style={{ borderColor: colourAt(label.colour).hex }} aria-label={`${label.name} rule card`}>
            <div className="brain-card-tag" style={{ background: colourAt(label.colour).hex }}>{cueLine(trial.rule)}</div>
            <div className="brain-card-face"><span>{trial.digit}</span><span>{trial.letter}</span></div>
          </div>
        )}
      </div>
      <ResponsePad buttons={[
        { id: 'F', label: 'Odd / vowel / over 5', hint: 'F', onPress: ts => block.respond('F', ts) },
        { id: 'J', label: 'Even / consonant / under 5', hint: 'J', onPress: ts => block.respond('J', ts) },
      ]} />
      <p className="brain-hint">The tag on the card names the rule to apply. F for odd or vowel, J for even or consonant.</p>
    </div>
  )
}

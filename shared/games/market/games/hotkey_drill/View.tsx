import { useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { HOTKEY_DRILL } from '../../config/difficulty.market'
import { DEFAULT_KEYS } from '../../engine/hotkeys'
import { createFrameClock } from '../../ui/frameClock'
import { createDrill, describePrompt, isDrillKey, makePrompt, summariseHotkeyDrill, type ErrorType, type Panel, type Prompt, type PromptResult, type Step } from './engine'

type Phase = 'play' | 'rest'
const ERROR_TEXT: Record<ErrorType, string> = {
  wrong_key: 'That key is not on the panel', nothing_staged: 'Nothing staged: pick an action first', wrong_action: 'Wrong action', wrong_side: 'Wrong side (CE or PE)',
  wrong_lots: 'Wrong number of lots', ignored_cue: 'That was an ignore cue: do nothing', missed: 'Too slow: the prompt expired',
}

export default function HotkeyDrillView({ level, params, seed, suspended, market, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const keys = market?.keys ?? DEFAULT_KEYS
  const latest = useRef({ onFinish, level, keys })
  latest.current = { onFinish, level, keys }
  const press = useRef<((key: string, timeStamp: number, mods?: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }) => void) | null>(null)
  const [phase, setPhase] = useState<Phase>('play')
  const [block, setBlock] = useState(1)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [panel, setPanel] = useState<Panel>({ lots: 1, staged: null })
  const [message, setMessage] = useState('')
  const [counts, setCounts] = useState({ correct: 0, errors: 0 })

  useEffect(() => { root.current?.focus() }, [phase, block])

  useEffect(() => {
    let cancelled = false
    const clock = createFrameClock({ suspended: () => suspendedRef.current })
    const rng = createRng(seed)
    const drill = createDrill(latest.current.keys)
    let promptId = 0
    let blockMs = 0
    let mode: 'gap' | 'prompt' | 'cue' = 'gap'
    let modeStart = 0
    let gapMs = 0
    const nextGap = () => params.gapMinMs + rng.next() * Math.max(0, params.gapMaxMs - params.gapMinMs)
    const beginGap = () => { mode = 'gap'; modeStart = blockMs; gapMs = nextGap(); setPrompt(null); setPanel({ lots: 1, staged: null }) }
    const tally = () => {
      const all = drill.results()
      const errors = all.reduce((n, r) => n + r.errors.length, 0) + drill.openErrors
      setCounts({ correct: all.filter(r => r.kind !== 'missed' && !r.errors.includes('ignored_cue')).length, errors })
    }

    press.current = (key, timeStamp, mods = {}) => {
      if (mode === 'gap') {
        // A key between prompts is not an answer to anything: it does not count (the next prompt is not on screen yet).
        return
      }
      const before = drill.results().length
      const outcome = drill.press({ key, ...mods }, timeStamp)
      setPanel({ ...drill.panel }); setStepIndex(drill.stepIndex)
      if (outcome.kind === 'error') setMessage(ERROR_TEXT[outcome.error])
      else if (outcome.kind === 'ignored_cue_error') { setMessage(ERROR_TEXT.ignored_cue); beginGap() }
      else if (outcome.kind === 'prompt_done') { setMessage(''); beginGap() }
      else if (outcome.kind === 'step_done') setMessage('')
      if (drill.results().length !== before || outcome.kind === 'error') tally()
    }

    ;(async () => {
      for (let b = 1; b <= HOTKEY_DRILL.blocks && !cancelled; b++) {
        setBlock(b); setPhase('play'); setMessage(''); blockMs = 0; beginGap()
        const limit = HOTKEY_DRILL.blockSec * 1000
        await clock.run(limit, ms => {
          blockMs = ms
          if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, 1 - ms / limit)})`
          if (mode === 'gap' && ms - modeStart >= gapMs) {
            const next = makePrompt(rng, ++promptId, params as { maxChain: number; ignoreShare: number; lotsMax: number })
            drill.start(next, performance.now())
            mode = next.ignore ? 'cue' : 'prompt'; modeStart = ms
            setPrompt(next); setStepIndex(0); setPanel({ lots: 1, staged: null }); setMessage('')
          } else if (mode === 'prompt' && ms - modeStart >= params.promptSec * 1000) {
            drill.expire(); setMessage(ERROR_TEXT.missed); tally(); beginGap()
          } else if (mode === 'cue' && ms - modeStart >= HOTKEY_DRILL.ignoreCueMs) {
            drill.settleIgnore(); tally(); beginGap()
          }
        })
        if (cancelled) return
        drill.abandon(); setPrompt(null)
        if (b < HOTKEY_DRILL.blocks) {
          setPhase('rest'); setMessage('')
          await clock.run(HOTKEY_DRILL.restSec * 1000, () => undefined)
        }
      }
      if (!cancelled) {
        const results: PromptResult[] = drill.results()
        latest.current.onFinish(summariseHotkeyDrill(results, params.rtSlow, latest.current.level))
      }
    })()
    return () => { cancelled = true; clock.cancel(); press.current = null }
  }, [params, seed])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    if (!isDrillKey(event)) return
    event.preventDefault(); event.stopPropagation()
    press.current?.(event.key, event.timeStamp, { ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey })
  }
  const click = (key: string) => press.current?.(key, performance.now())

  const step: Step | undefined = prompt?.steps[stepIndex]
  const label = (letter: string) => letter.toUpperCase()
  return (
    <div ref={root} className="games-market" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <p className="games-meta" role="status">{phase === 'rest' ? `Block ${block} done. Next block starting…` : `Block ${block} of ${HOTKEY_DRILL.blocks} · ${counts.correct} done · ${counts.errors} error${counts.errors === 1 ? '' : 's'}`}</p>
      <div className="games-countdown-bar" aria-hidden="true" data-active={phase === 'play'}><div ref={bar} /></div>
      <div className={`games-hotkey-prompt${prompt?.ignore ? ' is-ignore' : ''}`} role="status" aria-live="assertive">
        {phase === 'rest' ? 'Rest' : prompt ? prompt.text : ' '}
      </div>
      {prompt && !prompt.ignore && prompt.steps.length > 1 && <p className="games-meta">Step {stepIndex + 1} of {prompt.steps.length}: {step ? describePrompt([step]) : ''}</p>}
      <div className="games-hotkey-panel" aria-label="Mock order panel (nothing is sent anywhere)">
        <button onClick={() => click(keys.buyCe)} data-staged={panel.staged === 'buy_ce'}>Buy CE <kbd>{label(keys.buyCe)}</kbd></button>
        <button onClick={() => click(keys.buyPe)} data-staged={panel.staged === 'buy_pe'}>Buy PE <kbd>{label(keys.buyPe)}</kbd></button>
        <button onClick={() => click(keys.exitAll)} data-staged={panel.staged === 'exit_all'}>Exit all <kbd>{label(keys.exitAll)}</kbd></button>
        <button onClick={() => click(keys.stopCost)} data-staged={panel.staged === 'stop_cost'}>Stop to cost <kbd>{label(keys.stopCost)}</kbd></button>
        <span className="games-hotkey-lots">Lots <button onClick={() => click('ArrowDown')} aria-label="Fewer lots">−</button> <strong>{panel.lots}</strong> <button onClick={() => click('ArrowUp')} aria-label="More lots">+</button> <kbd>1–5</kbd></span>
        <button onClick={() => click('Enter')}>Confirm <kbd>Enter</kbd></button>
      </div>
      <p className="games-hotkey-message" role="alert">{message || ' '}</p>
      <p className="games-hint">Do exactly what the prompt says on the panel. Wrong keys are counted; ignore cues mean do nothing.</p>
    </div>
  )
}

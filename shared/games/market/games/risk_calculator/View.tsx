import { useEffect, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { RISK_CALCULATOR } from '../../config/difficulty.market'
import { createFrameClock } from '../../ui/frameClock'
import { DEFAULT_LOT_SIZE, judge, makeQuestion, parseEntry, planTypes, summariseRiskCalculator, TYPE_LABEL, type Question, type QuestionResult } from './engine'

type Phase = 'loading' | 'ask' | 'feedback'

const withUnit = (value: number, unit: string): string => (unit === '₹' ? `₹${value.toLocaleString('en-IN')}` : unit === '%' ? `${value}%` : `${value} ${unit}`)

const VERDICT_TEXT: Record<QuestionResult['verdict'], string> = { correct: 'Correct', close: 'Close: counted as half', wrong: 'Not quite', timeout: 'Time is up' }

export default function RiskCalculatorView({ level, params, seed, suspended, market, onFinish }: GameViewProps) {
  const input = useRef<HTMLInputElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const typed = useRef('')
  const submitted = useRef(false)
  const advance = useRef(false)
  const [phase, setPhase] = useState<Phase>('loading')
  const [question, setQuestion] = useState<Question | null>(null)
  const [result, setResult] = useState<QuestionResult | null>(null)
  const [text, setText] = useState('')
  const [index, setIndex] = useState(0)
  const latest = useRef({ onFinish, level })
  latest.current = { onFinish, level }
  const total = params.questions

  useEffect(() => { if (phase === 'ask') input.current?.focus() }, [phase, index])

  useEffect(() => {
    let cancelled = false
    const clock = createFrameClock({ suspended: () => suspendedRef.current })
    ;(async () => {
      // The lot size is the one thing taken from the server, once; without it the game uses the NIFTY lot and still works offline.
      let lotSize = DEFAULT_LOT_SIZE
      try {
        const availability = await market?.data.availability()
        const fromServer = availability?.symbols?.NIFTY?.lot_size
        if (typeof fromServer === 'number' && fromServer > 0) lotSize = fromServer
      } catch { /* offline: keep the default */ }
      if (cancelled) return
      const rng = createRng(seed)
      const types = planTypes(rng, total, params.typePool)
      const results: QuestionResult[] = []
      for (let i = 0; i < total && !cancelled; i++) {
        const q = makeQuestion(rng, types[i], { ugliness: params.ugliness, lotsMax: params.lotsMax, maxSteps: params.maxSteps, typePool: params.typePool }, { lotSize })
        typed.current = ''; submitted.current = false; advance.current = false
        setQuestion(q); setText(''); setResult(null); setIndex(i + 1); setPhase('ask')
        const limitMs = params.timeSec * 1000
        let spent = 0
        await clock.run(limitMs, ms => { spent = ms; if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, 1 - ms / limitMs)})` }, () => submitted.current)
        if (cancelled) return
        const entered = submitted.current ? parseEntry(typed.current) : null
        const judged = judge(q, entered, submitted.current ? spent : limitMs, params.timeSec)
        results.push(judged)
        setResult(judged); setPhase('feedback')
        await clock.run(RISK_CALCULATOR.feedbackMs, () => undefined, () => advance.current)
      }
      if (!cancelled) latest.current.onFinish(summariseRiskCalculator(results, latest.current.level))
    })()
    return () => { cancelled = true; clock.cancel() }
  }, [market, params, seed, total])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter') return
    event.preventDefault(); event.stopPropagation()
    if (phase === 'ask' && !submitted.current) submitted.current = true
    else if (phase === 'feedback') advance.current = true
  }

  return (
    <div className="games-market" onKeyDown={onKeyDown}>
      <p className="games-meta" role="status">{phase === 'loading' ? 'Getting ready…' : `Question ${index} of ${total}${question ? ` · ${TYPE_LABEL[question.type]}` : ''}`}</p>
      <div className="games-countdown-bar" aria-hidden="true" data-active={phase === 'ask'}><div ref={bar} /></div>
      <div className="games-risk-question" aria-live="polite">{question ? question.prompt : ' '}</div>
      <label className="games-risk-answer">Your answer{question ? ` (${question.unit})` : ''}
        <input ref={input} inputMode="decimal" autoComplete="off" value={text} disabled={phase !== 'ask'}
          onChange={event => { typed.current = event.target.value; setText(event.target.value) }} aria-label="Your answer" />
      </label>
      <div className="games-market-pad"><button onClick={() => { if (phase === 'ask') submitted.current = true; else if (phase === 'feedback') advance.current = true }} disabled={phase === 'loading'}>{phase === 'feedback' ? 'Next' : 'Submit'} <kbd>Enter</kbd></button></div>
      {phase === 'feedback' && question && result && (
        <div className="games-market-flash" role="status">
          <p><strong>{VERDICT_TEXT[result.verdict]}.</strong> The answer is {withUnit(question.answer, question.unit)}{result.entered !== null && result.verdict !== 'correct' ? `; you entered ${result.entered}` : ''}.</p>
          <p className="games-meta">{question.working}</p>
        </div>
      )}
      {phase === 'ask' && <p className="games-hint">Type the number and press Enter. Decimals are fine; rounding to two places is accepted.</p>}
    </div>
  )
}

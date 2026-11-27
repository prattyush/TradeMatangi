import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import { getGame, isPlayable } from '../../../core/registry'
import { RISK_CALCULATOR, RISK_CALCULATOR_PARAMS } from '../../config/difficulty.market'
import '../../../games'
import View from './View'
import { DEFAULT_LOT_SIZE, judge, makeQuestion, parseEntry, planTypes, QUESTION_TYPES, summariseRiskCalculator, typesFor, type Question, type QuestionParams, type QuestionResult, type QuestionType } from './engine'

const L = 65
const ctx = { lotSize: L }
const base: QuestionParams = { ugliness: 0.6, lotsMax: 4, maxSteps: 2, typePool: 8 }

/** The numbers back out of the prompt text, so the answer is recomputed independently of the generator's own variables. */
/** The answers are rounded to two places, so they can differ from the exact value by half a hundredth. */
const near = (actual: number, exact: number) => expect(Math.abs(actual - exact)).toBeLessThanOrEqual(0.0051)
const nums = (text: string): number[] => (text.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? []).map(Number)

describe('question generation', () => {
  it('is deterministic for a seed and finite for every type at every level', () => {
    for (const type of QUESTION_TYPES) {
      expect(makeQuestion(createRng(5), type, base, ctx)).toEqual(makeQuestion(createRng(5), type, base, ctx))
      for (let level = 1; level <= 20; level++) {
        const p = paramsAt(RISK_CALCULATOR_PARAMS, level)
        const q = makeQuestion(createRng(level * 31 + type), type, { ugliness: p.ugliness, lotsMax: p.lotsMax, maxSteps: p.maxSteps, typePool: p.typePool }, ctx)
        expect(Number.isFinite(q.answer), `type ${type} level ${level}`).toBe(true)
        expect(q.answer).toBeGreaterThan(0); expect(q.prompt.length).toBeGreaterThan(15); expect(q.working).not.toMatch(/NaN|undefined|Infinity/)
        expect(q.steps).toBeGreaterThanOrEqual(1); expect(q.steps).toBeLessThanOrEqual(Math.max(p.maxSteps, 2))
      }
    }
  })
  it('type 1: rupee risk = stop points x lots x lot size', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const q = makeQuestion(createRng(seed), 1, base, ctx)
      const [stop, lots] = nums(q.prompt)
      expect(q.answer).toBe(Math.round(stop * lots * L)); expect(q.unit).toBe('₹')
    }
  })
  it('type 2: reward to risk from entry, stop and target', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const q = makeQuestion(createRng(seed), 2, base, ctx)
      const [entry, stop, target] = nums(q.prompt)
      near(q.answer, (target - entry) / (entry - stop))
    }
  })
  it('type 3: breakeven = entry + cost per lot / lot size', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const q = makeQuestion(createRng(seed), 3, base, ctx)
      const [entry, cost] = nums(q.prompt)
      near(q.answer, entry + cost / L)
    }
  })
  it('type 4: the whole lots a budget allows', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const q = makeQuestion(createRng(seed), 4, base, ctx)
      const [budget, stop] = nums(q.prompt)
      expect(q.answer).toBe(Math.floor(budget / (stop * L))); expect(q.answer).toBeGreaterThanOrEqual(1)
      expect(q.exactTol).toBe(0); expect(q.closeRel).toBe(0)
    }
  })
  it('type 5: percent of capital at risk', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const q = makeQuestion(createRng(seed), 5, base, ctx)
      const [capital, stop, lots] = nums(q.prompt)
      near(q.answer, ((stop * lots * L) / capital) * 100)
    }
  })
  it('type 6: delta x move, with gamma from the third step', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const two = makeQuestion(createRng(seed), 6, { ...base, maxSteps: 1 }, ctx); const [delta, move] = nums(two.prompt)
      near(two.answer, delta * move); expect(two.steps).toBe(1)
      const three = makeQuestion(createRng(seed), 6, { ...base, maxSteps: 3 }, ctx); const [d, g, m] = nums(three.prompt)
      near(three.answer, d * m + 0.5 * g * m * m); expect(three.steps).toBe(3)
    }
  })
  it('type 7: new average entry, then breakeven at three steps', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const two = makeQuestion(createRng(seed), 7, { ...base, maxSteps: 2 }, ctx); const [l1, p1, l2, p2] = nums(two.prompt)
      near(two.answer, (l1 * p1 + l2 * p2) / (l1 + l2))
      const three = makeQuestion(createRng(seed), 7, { ...base, maxSteps: 3 }, ctx); const [m1, q1, m2, q2, cost] = nums(three.prompt)
      near(three.answer, (m1 * q1 + m2 * q2) / (m1 + m2) + cost / L)
    }
  })
  it('type 8: lots that fit, then the cost (two steps) or the risk actually taken (three)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const two = makeQuestion(createRng(seed), 8, { ...base, maxSteps: 2 }, ctx); const [budget, stop, , cost] = nums(two.prompt)
      expect(two.answer).toBe(Math.floor(budget / (stop * L)) * cost)
      const three = makeQuestion(createRng(seed), 8, { ...base, maxSteps: 3 }, ctx); const [b3, s3] = nums(three.prompt)
      expect(three.answer).toBe(Math.round(Math.floor(b3 / (s3 * L)) * s3 * L)); expect(three.answer).toBeLessThanOrEqual(b3)
    }
  })
  it('the numbers get uglier with the level, and use the lot size it is given', () => {
    const tidy = makeQuestion(createRng(3), 1, { ...base, ugliness: 0 }, ctx), ugly = makeQuestion(createRng(3), 1, { ...base, ugliness: 1 }, ctx)
    expect(Number.isInteger(nums(tidy.prompt)[0]) && nums(tidy.prompt)[0] % 5 === 0).toBe(true)
    expect(nums(ugly.prompt)[0] * 20 % 1).toBeCloseTo(0, 6)
    const other = makeQuestion(createRng(3), 1, base, { lotSize: 20 }); expect(other.prompt).toContain('of 20')
    expect(DEFAULT_LOT_SIZE).toBe(65)
  })
  it('type pool unlocks in order and a session plan covers the pool evenly', () => {
    expect(typesFor(2)).toEqual([1, 2]); expect(typesFor(99)).toEqual([...QUESTION_TYPES]); expect(typesFor(0)).toEqual([1])
    expect(paramsAt(RISK_CALCULATOR_PARAMS, 1).typePool).toBe(2); expect(paramsAt(RISK_CALCULATOR_PARAMS, 20).typePool).toBe(8)
    const plan = planTypes(createRng(2), 12, 3)
    expect(plan.length).toBe(12); expect(new Set(plan)).toEqual(new Set([1, 2, 3])); for (const t of [1, 2, 3] as QuestionType[]) expect(plan.filter(x => x === t).length).toBe(4)
  })
})

describe('judging', () => {
  const q = (over: Partial<Question> = {}): Question => ({ type: 3, prompt: 'p', unit: 'pts', answer: 86.29, exactTol: 0.01, closeRel: 0.02, working: 'w', steps: 2, ...over })
  it('a correct answer scores 0.7 plus up to 0.3 for speed; a close one half of that; wrong and late score nothing', () => {
    expect(judge(q(), 86.29, 0, 20)).toMatchObject({ verdict: 'correct', score: 1 })
    expect(judge(q(), 86.3, 10_000, 20).score).toBeCloseTo(0.85, 9)
    expect(judge(q(), 86.29, 19_999, 20).score).toBeCloseTo(RISK_CALCULATOR.baseCredit, 2)
    expect(judge(q(), 87, 0, 20)).toMatchObject({ verdict: 'close', score: 0.5 })
    expect(judge(q(), 90, 0, 20)).toMatchObject({ verdict: 'wrong', score: 0 })
    expect(judge(q(), 86.29, 20_000, 20)).toMatchObject({ verdict: 'timeout', score: 0 })
    expect(judge(q(), null, 5000, 20)).toMatchObject({ verdict: 'wrong', score: 0 }); expect(judge(q(), null, 20_000, 20).verdict).toBe('timeout')
  })
  it('an exact-only question (lots) has no close credit', () => {
    const lots = q({ type: 4, answer: 3, exactTol: 0, closeRel: 0 })
    expect(judge(lots, 3, 0, 20).verdict).toBe('correct'); expect(judge(lots, 4, 0, 20).verdict).toBe('wrong'); expect(judge(lots, 2.99, 0, 20).verdict).toBe('wrong')
  })
  it('reads what was typed', () => {
    expect(parseEntry('1,605')).toBe(1605); expect(parseEntry(' 86.29 ')).toBe(86.29); expect(parseEntry('₹1605')).toBe(1605); expect(parseEntry('-3')).toBe(-3); expect(parseEntry('.5')).toBe(0.5); expect(parseEntry('12.')).toBe(12)
    for (const bad of ['', 'abc', '1.2.3', '--4', '5 6', 'NaN', '1e5']) expect(parseEntry(bad)).toBeNull()
  })
})

describe('session summary and simulated players', () => {
  const results = (verdicts: Array<[QuestionType, QuestionResult['verdict'], number]>): QuestionResult[] => verdicts.map(([type, verdict, timeMs]) => ({ type, verdict, timeMs, entered: 1, answer: 1, score: verdict === 'correct' ? 1 : verdict === 'close' ? 0.5 : 0 }))
  it('score is 100 x the mean round score, with accuracy by type and the most missed type', () => {
    const summary = summariseRiskCalculator(results([[1, 'correct', 3000], [1, 'wrong', 5000], [2, 'close', 4000], [3, 'timeout', 9000], [3, 'wrong', 7000]]))
    expect(summary.score).toBe(30)
    expect(summary.stats).toMatchObject({ questions: 5, correct: 1, median_ms: 5000, acc_q1: 50, acc_q2: 100, acc_q3: 0, most_missed: 3 })
    for (const key of Object.keys(summary.stats!)) expect(key).toMatch(/^[a-z0-9_]+$/)
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20)
    expect(summariseRiskCalculator([]).score).toBe(0); expect(summariseRiskCalculator(results([[1, 'correct', 100]])).stats!.most_missed).toBe(0)
  })
  it('a perfect and fast player scores near 100, a random guesser near 0, a slow perfect one about 70', () => {
    const play = (answerWith: (q: Question) => number | null, timeMs: number) => {
      const rng = createRng(11); const out: QuestionResult[] = []
      for (const type of planTypes(rng, 40, 8)) { const question = makeQuestion(rng, type, base, ctx); out.push(judge(question, answerWith(question), timeMs, 15)) }
      return summariseRiskCalculator(out).score
    }
    expect(play(x => x.answer, 600)).toBeGreaterThanOrEqual(95)
    expect(play(x => x.answer, 14_000)).toBeLessThanOrEqual(75)
    expect(play(x => x.answer, 14_000)).toBeGreaterThanOrEqual(68)
    const rng = createRng(4)
    expect(play(() => Math.round(rng.next() * 1000), 3000)).toBeLessThanOrEqual(5)
    expect(play(() => null, 3000)).toBe(0)
  })
})

describe('registration and first paint', () => {
  it('is a playable market game in Math with a parameter at every level', () => {
    expect(isPlayable('risk_calculator')).toBe(true)
    const game = getGame('risk_calculator')!
    expect(game.kind).toBe('market'); expect(game.category).toBe('math'); expect(game.instructions.length).toBeLessThanOrEqual(6)
    for (let level = 1; level <= 20; level++) {
      const p = paramsAt(game.paramTable, level)
      for (const [key, value] of Object.entries(p)) expect(Number.isFinite(value), `L${level} ${key}`).toBe(true)
      if (game.kind === 'market') expect(game.roundsPerSession(level)).toBe(p.questions)
    }
    expect(paramsAt(game.paramTable, 1)).toMatchObject({ questions: 12, timeSec: 25, maxSteps: 1 }); expect(paramsAt(game.paramTable, 20)).toMatchObject({ questions: 20, timeSec: 8, maxSteps: 3 })
  })
  it('first paint is a disabled answer box and a Submit button', () => {
    const html = renderToStaticMarkup(createElement(View, { level: 1, mode: 'practice', params: paramsAt(RISK_CALCULATOR_PARAMS, 1), rng: createRng(1), seed: 1, suspended: false, onFinish: () => undefined, onAbort: () => undefined }))
    expect(html).toContain('Getting ready'); expect(html).toContain('aria-label="Your answer"'); expect(html).toContain('disabled=""')
  })
})

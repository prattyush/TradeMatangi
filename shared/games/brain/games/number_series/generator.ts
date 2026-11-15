/**
 * Number Series generator and rule solver (spec 17.5 #17). Pure and seeded.
 *
 * UNIQUENESS: `fits(prefix)` is a small rule-solver over the whole rule library: for every family whose rule reproduces ALL the
 * shown terms it gives the term that rule predicts next. A puzzle is accepted only when every fitting family predicts the same
 * next term, and it is the intended one, so the question has one answer whatever rule the player has in mind.
 */
import { createRng, type Rng } from '../../../core/rng'

export type Family = 'arithmetic' | 'geometric' | 'alternating' | 'second_order' | 'power' | 'linear' | 'fibonacci' | 'interleaved' | 'digit_sum'
export const FAMILIES: Family[] = ['arithmetic', 'geometric', 'alternating', 'second_order', 'power', 'linear', 'fibonacci', 'interleaved', 'digit_sum']
/** The tier (difficulty parameter `tier`) at which a family joins the pool. */
export const FAMILY_TIER: Record<Family, number> = {
  arithmetic: 0, geometric: 0, alternating: 1, second_order: 1, power: 2, linear: 2, fibonacci: 2, interleaved: 3, digit_sum: 4,
}
export const familiesAt = (tier: number): Family[] => FAMILIES.filter(family => FAMILY_TIER[family] <= tier)
const LIMIT = 99999

export interface SeriesPuzzle {
  /** The shown terms. */
  terms: number[]
  answer: number
  family: Family
  /** The rule in words, for the review. */
  rule: string
  /** Five choices (the answer among them), shuffled. */
  options: number[]
}

const digitSum = (n: number) => String(Math.abs(n)).split('').reduce((s, d) => s + Number(d), 0)
const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b))

// ---- the solver: does a family reproduce every shown term, and what does it say comes next? -------------------------------
type Fit = (terms: number[]) => number[]
const one = (value: number | null): number[] => (value === null || !Number.isFinite(value) ? [] : [value])
/** A geometric step of two terms (p/q reduced), or an arithmetic step, as plain helpers for the woven series. */
const arithmeticNext = (t: number[]): number | null => (t.length >= 2 && t.every((v, i) => i === 0 || v - t[i - 1] === t[1] - t[0]) ? t[t.length - 1] + (t[1] - t[0]) : null)
function geometricNext(t: number[]): number | null {
  if (t.length < 2 || t[0] === 0) return null
  const g = gcd(t[1], t[0]) || 1
  const p = t[1] / g, q = t[0] / g
  if (p === q || !t.every((v, i) => i === 0 || v * q === t[i - 1] * p)) return null
  const next = (t[t.length - 1] * p) / q
  return Number.isInteger(next) ? next : null
}
const FITS: Record<Family, Fit> = {
  arithmetic: t => (t.length < 3 ? [] : one(arithmeticNext(t))),
  geometric: t => (t.length < 3 ? [] : one(geometricNext(t))),
  alternating(t) {
    if (t.length < 4) return []
    for (const addFirst of [true, false]) {
      // steps alternate: add a, multiply by b (or the other way round)
      const a = addFirst ? t[1] - t[0] : t[2] - t[1]
      const ratioFrom = addFirst ? 1 : 0
      if (t[ratioFrom] === 0 || t[ratioFrom + 1] % t[ratioFrom] !== 0) continue
      const b = t[ratioFrom + 1] / t[ratioFrom]
      let ok = true
      for (let i = 1; i < t.length && ok; i++) {
        const addStep = (i % 2 === 1) === addFirst
        ok = t[i] === (addStep ? t[i - 1] + a : t[i - 1] * b)
      }
      if (!ok) continue
      const addNext = (t.length % 2 === 1) === addFirst
      return [addNext ? t[t.length - 1] + a : t[t.length - 1] * b]
    }
    return []
  },
  second_order(t) {
    if (t.length < 4) return []
    const d1 = t.slice(1).map((v, i) => v - t[i])
    const d2 = d1[1] - d1[0]
    return d1.every((v, i) => i === 0 || v - d1[i - 1] === d2) ? [t[t.length - 1] + d1[d1.length - 1] + d2] : []
  },
  power(t) {
    for (const p of [2, 3]) for (let k = 1; k <= 15; k++) {
      const c = t[0] - k ** p
      if (Math.abs(c) <= 40 && t.every((v, i) => v === (k + i) ** p + c)) return [(k + t.length) ** p + c]
    }
    return []
  },
  linear(t) {
    if (t.length < 4) return []
    const den = t[1] - t[0]
    if (den === 0 || (t[2] - t[1]) % den !== 0) return []
    const a = (t[2] - t[1]) / den
    if (a < 2 || a > 5) return []
    const b = t[1] - a * t[0]
    return t.every((v, i) => i === 0 || v === a * t[i - 1] + b) ? [a * t[t.length - 1] + b] : []
  },
  fibonacci(t) {
    if (t.length < 3) return []
    return t.every((v, i) => i < 2 || v === t[i - 1] + t[i - 2]) ? [t[t.length - 1] + t[t.length - 2]] : []
  },
  interleaved(t) {
    if (t.length < 5) return []
    // Two series woven together: each is arithmetic or geometric. Every reading that fits the series to be continued counts.
    const mine = t.filter((_, i) => i % 2 === t.length % 2)
    const other = t.filter((_, i) => i % 2 !== t.length % 2)
    if (other.length < 2 || (arithmeticNext(other) === null && geometricNext(other) === null)) return []
    return [...new Set([...one(arithmeticNext(mine)), ...one(geometricNext(mine))])]
  },
  digit_sum(t) {
    if (t.length < 3) return []
    return t.every((v, i) => i === 0 || v === t[i - 1] + digitSum(t[i - 1])) ? [t[t.length - 1] + digitSum(t[t.length - 1])] : []
  },
}

/** Every family that reproduces all of `terms`, with the term it predicts next. */
export function fits(terms: number[]): Array<{ family: Family; next: number }> {
  const out: Array<{ family: Family; next: number }> = []
  for (const family of FAMILIES) for (const next of FITS[family](terms)) out.push({ family, next })
  return out
}

export function isUnambiguousSeries(shown: number[], answer: number): boolean {
  const found = fits(shown)
  return found.length > 0 && found.every(f => f.next === answer)
}

// ---- generators: the whole series (shown terms plus the answer) for one family -----------------------------------------
const series = (length: number, next: (prev: number[], i: number) => number, first: number[]): number[] => {
  const out = [...first]
  while (out.length < length) out.push(next(out, out.length))
  return out
}

interface Made { terms: number[]; rule: string }
type Maker = (rng: Rng, length: number, tier: number) => Made
const big = (tier: number) => (tier >= 3 ? 2 : 1)
const MAKERS: Record<Family, Maker> = {
  arithmetic(rng, n, tier) {
    const d = rng.int(2, 6 * big(tier)) * (tier >= 2 && rng.chance(0.3) ? -1 : 1), a = d < 0 ? rng.int(40, 90) : rng.int(1, 25)
    return { terms: series(n, p => p[p.length - 1] + d, [a]), rule: `add ${d}` }
  },
  geometric(rng, n, tier) {
    if (tier >= 1 && rng.chance(0.3)) { const r = rng.int(2, 3), a = r ** (n - 1) * rng.int(1, 3); return { terms: series(n, p => p[p.length - 1] / r, [a]), rule: `divide by ${r}` } }
    const r = rng.int(2, tier >= 2 ? 4 : 3), a = rng.int(1, 5)
    return { terms: series(n, p => p[p.length - 1] * r, [a]), rule: `multiply by ${r}` }
  },
  alternating(rng, n, tier) {
    const a = rng.int(2, 8 * big(tier)), b = rng.int(2, 3), first = rng.int(1, 8), addFirst = rng.chance(0.5)
    return { terms: series(n, (p, i) => ((i % 2 === 1) === addFirst ? p[i - 1] + a : p[i - 1] * b), [first]), rule: `${addFirst ? `add ${a}, multiply by ${b}` : `multiply by ${b}, add ${a}`}, alternating` }
  },
  second_order(rng, n, tier) {
    const d1 = rng.int(1, 5), d2 = rng.int(1, 3 * big(tier)), a = rng.int(1, 12)
    const out = [a]; let step = d1
    while (out.length < n) { out.push(out[out.length - 1] + step); step += d2 }
    return { terms: out, rule: `differences grow by ${d2}` }
  },
  power(rng, n, tier) {
    const p = tier >= 3 && rng.chance(0.5) ? 3 : 2, k = rng.int(1, 6), c = rng.int(-9, 9)
    return { terms: Array.from({ length: n }, (_, i) => (k + i) ** p + c), rule: `${p === 2 ? 'squares' : 'cubes'} ${c >= 0 ? '+' : '-'} ${Math.abs(c)}` }
  },
  linear(rng, n) {
    const a = rng.int(2, 3), b = rng.int(-3, 6), first = rng.int(1, 6)
    return { terms: series(n, p => a * p[p.length - 1] + b, [first]), rule: `multiply by ${a}, ${b >= 0 ? 'add' : 'subtract'} ${Math.abs(b)}` }
  },
  fibonacci(rng, n) {
    const a = rng.int(1, 6), b = rng.int(1, 6)
    return { terms: series(n, p => p[p.length - 1] + p[p.length - 2], [a, b]), rule: 'each term is the sum of the two before' }
  },
  interleaved(rng, n, tier) {
    const a = rng.int(1, 20), da = rng.int(2, 5 * big(tier)), b = rng.int(1, 9)
    const geometric = rng.chance(0.4), db = geometric ? rng.int(2, 3) : rng.int(2, 6)
    const out: number[] = []
    for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? a + da * (i / 2) : geometric ? b * db ** ((i - 1) / 2) : b + db * ((i - 1) / 2))
    return { terms: out, rule: `two series woven together: add ${da} on odd places, ${geometric ? `multiply by ${db}` : `add ${db}`} on even places` }
  },
  digit_sum(rng, n) {
    const a = rng.int(1, 40)
    return { terms: series(n, p => p[p.length - 1] + digitSum(p[p.length - 1]), [a]), rule: 'add the digit sum of the previous term' }
  },
}

// ---- distractors: the answers plausible mistakes give --------------------------------------------------------------------------
function distractors(rng: Rng, shown: number[], answer: number, count: number): number[] {
  const last = shown[shown.length - 1], prev = shown[shown.length - 2]
  const ratio = prev !== 0 && last % prev === 0 ? last / prev : null
  const dl = last - prev, dp = prev - shown[shown.length - 3]
  const candidates = [
    last + dl,                         // an arithmetic step of the last difference
    ratio !== null ? last * ratio : last + 2 * dl, // repeating the last ratio
    last + dp,                         // the step before the last
    last + dl + (dl - dp),             // a second-order guess
    answer + 1, answer - 1, answer + 2, answer - 2, answer + dl, answer - dl, answer * 2, last + 1,
  ]
  const picked: number[] = []
  for (const value of candidates) if (Number.isFinite(value) && value !== answer && !picked.includes(value) && Math.abs(value) <= LIMIT) picked.push(value)
  // Prefer the rule-based mistakes (the first four), then the off-by-one family.
  const chosen = picked.slice(0, count)
  for (let guard = 0; chosen.length < count && guard < 50; guard++) {
    const value = answer + rng.int(-9, 9)
    if (value !== answer && !chosen.includes(value)) chosen.push(value)
  }
  return chosen
}

export interface SeriesParams { tier: number; shown: number }

export function generateSeries(rng: Rng, params: SeriesParams): SeriesPuzzle {
  const pool = familiesAt(Math.round(params.tier))
  const shown = Math.max(5, Math.round(params.shown))
  for (let attempt = 0; attempt < 80; attempt++) {
    const family = rng.pick(pool)
    const { terms, rule } = MAKERS[family](rng, shown + 1, Math.round(params.tier))
    // Early levels keep the numbers small enough to read at a glance.
    const cap = params.tier <= 1 ? 3000 : LIMIT
    if (terms.some(v => !Number.isInteger(v) || Math.abs(v) > cap)) continue
    const prefix = terms.slice(0, shown), answer = terms[shown]
    const options = rng.shuffle([answer, ...distractors(rng, prefix, answer, 4)])
    const puzzle: SeriesPuzzle = { terms: prefix, answer, family, rule, options }
    if (options.length < 5) continue
    if (isUnambiguousSeries(prefix, answer)) return puzzle
  }
  // Always possible: an arithmetic series with enough terms is unambiguous.
  const prefix = Array.from({ length: shown }, (_, i) => 3 + 4 * i), answer = 3 + 4 * shown
  return { terms: prefix, answer, family: 'arithmetic', rule: 'add 4', options: rng.shuffle([answer, ...distractors(rng, prefix, answer, 4)]) }
}

export interface GenerateSeriesArgs { params: Record<string, number>; seed: number; count: number }
export function generateSeriesSet({ params, seed, count }: GenerateSeriesArgs): SeriesPuzzle[] {
  const rng = createRng(seed)
  return Array.from({ length: count }, () => generateSeries(rng, { tier: params.tier, shown: params.shown }))
}

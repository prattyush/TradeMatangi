/**
 * Code Breaker solver and code generator (spec 17.5 #18): Mastermind / Bulls-and-Cows. Pure and seeded.
 * `par` is how many guesses a simple solver needs on a code: it always guesses the first code that is still consistent with
 * all the feedback so far (the player's best sensible play), so a player who reasons carefully reaches par.
 */
import { createRng, type Rng } from '../../../core/rng'

export interface Feedback { exact: number; misplaced: number }
export type HiddenValue = 'exact' | 'misplaced'
export interface CodePuzzle {
  secret: number[]
  /** Guesses the simple solver needs. */
  par: number
  /** From level 16: which feedback value is hidden ("?") on which guess (0-based), once per code. */
  hidden: { guess: number; value: HiddenValue } | null
}

/** Exact = right symbol in the right place; misplaced = right symbol in the wrong place (each symbol counted once). */
export function feedback(secret: number[], guess: number[]): Feedback {
  let exact = 0
  const secretCounts = new Map<number, number>(), guessCounts = new Map<number, number>()
  for (let i = 0; i < secret.length; i++) {
    if (secret[i] === guess[i]) exact += 1
    else {
      secretCounts.set(secret[i], (secretCounts.get(secret[i]) ?? 0) + 1)
      guessCounts.set(guess[i], (guessCounts.get(guess[i]) ?? 0) + 1)
    }
  }
  let misplaced = 0
  for (const [symbol, n] of guessCounts) misplaced += Math.min(n, secretCounts.get(symbol) ?? 0)
  return { exact, misplaced }
}

/** Every possible code, in order. */
export function allCodes(length: number, symbols: number, repeats: boolean): number[][] {
  const out: number[][] = []
  const build = (prefix: number[]) => {
    if (prefix.length === length) { out.push(prefix); return }
    for (let s = 0; s < symbols; s++) if (repeats || !prefix.includes(s)) build([...prefix, s])
  }
  build([])
  return out
}

/** The opening guess of the simple solver: 0 0 1 1 ... with repeats, 0 1 2 ... without. */
export const openingGuess = (length: number, repeats: boolean): number[] => Array.from({ length }, (_, i) => (repeats ? Math.floor(i / 2) : i))

/**
 * The guesses the simple solver makes to find `secret` (it uses the true feedback, except the one value hidden from the player:
 * `par` is what is achievable with the information the player gets).
 */
export function solverGuesses(secret: number[], symbols: number, repeats: boolean, limit = 30, hidden: CodePuzzle['hidden'] = null): number[][] {
  let candidates = allCodes(secret.length, symbols, repeats)
  const guesses: number[][] = []
  let guess = openingGuess(secret.length, repeats)
  for (let i = 0; i < limit; i++) {
    guesses.push(guess)
    if (guess.every((s, k) => s === secret[k])) break
    const fb = feedback(secret, guess)
    const hideExact = hidden !== null && hidden.guess === i && hidden.value === 'exact'
    const hideMisplaced = hidden !== null && hidden.guess === i && hidden.value === 'misplaced'
    const before = guess
    candidates = candidates.filter(code => {
      const f = feedback(code, before)
      return (hideExact || f.exact === fb.exact) && (hideMisplaced || f.misplaced === fb.misplaced)
    })
    guess = candidates[0]
  }
  return guesses
}

export interface CodeParams { length: number; symbols: number; repeats: number; hidden: number; guesses: number }

export function generateCode(rng: Rng, params: CodeParams): CodePuzzle {
  const length = Math.round(params.length), symbols = Math.round(params.symbols), repeats = params.repeats >= 1
  const limit = Math.round(params.guesses)
  let secret: number[] = [], par = 0
  const hidden = params.hidden >= 1 ? { guess: rng.int(1, 3), value: rng.pick<HiddenValue>(['exact', 'misplaced']) } : null
  // A code the careful solver cannot crack inside the guess limit (with one guess to spare) would be unfair: draw another.
  for (let attempt = 0; attempt < 40; attempt++) {
    secret = []
    for (let i = 0; i < length; i++) {
      let s = rng.int(0, symbols - 1)
      while (!repeats && secret.includes(s)) s = rng.int(0, symbols - 1)
      secret.push(s)
    }
    par = solverGuesses(secret, symbols, repeats, 30, hidden).length
    if (par <= limit - 1) break
  }
  return { secret, par, hidden }
}

export interface GenerateCodesArgs { params: Record<string, number>; seed: number; count: number }
export function generateCodes({ params, seed, count }: GenerateCodesArgs): CodePuzzle[] {
  const rng = createRng(seed)
  const spec: CodeParams = { length: params.length, symbols: params.symbols, repeats: params.repeats, hidden: params.hidden, guesses: params.guesses }
  return Array.from({ length: count }, () => generateCode(rng, spec))
}

/**
 * Could this guess still be the code, given what the earlier guesses showed? Only the feedback the player could SEE counts: a
 * hidden value is skipped.
 */
export function isConsistent(guess: number[], earlier: number[][], secret: number[], hidden: CodePuzzle['hidden']): boolean {
  return earlier.every((previous, index) => {
    const shown = feedback(secret, previous), candidate = feedback(previous, guess)
    const hideExact = hidden !== null && hidden.guess === index && hidden.value === 'exact'
    const hideMisplaced = hidden !== null && hidden.guess === index && hidden.value === 'misplaced'
    return (hideExact || shown.exact === candidate.exact) && (hideMisplaced || shown.misplaced === candidate.misplaced)
  })
}

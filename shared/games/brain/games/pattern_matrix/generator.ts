/**
 * Pattern Matrix generator and rule solver (spec 17.5 #16). A 3x3 matrix of figures; the last cell is missing. Each figure has
 * attributes; every attribute follows a rule along the rows, so the missing cell is derived from the rules. Pure and seeded.
 *
 * Rules (per attribute): `fixed` (same everywhere), `constant` (each row holds one value, rows differ), `progression` (a step of
 * +-1 or +-2 along the row), `distribute` (each row holds the same three values, each once), and `logic` (the 2x2 dot mask: the
 * third cell is the XOR or the AND of the first two; from level 14).
 *
 * UNIQUENESS: `predictions()` is a small rule-solver. For one attribute it lists, for every rule that fits the eight visible
 * cells, the value that rule gives for the missing cell. A puzzle is accepted only when every attribute has exactly one
 * predicted value, so there is exactly one right figure; every distractor differs from it in at least one attribute and so
 * breaks that attribute's rule (`distractorsAreWrong` re-checks this for the finished puzzle).
 */
import { createRng, type Rng } from '../../../core/rng'

export const ATTRS = ['shape', 'count', 'size', 'colour', 'rotation', 'shading'] as const
export type Attr = typeof ATTRS[number]
export const DOMAIN: Record<Attr, number> = { shape: 5, count: 4, size: 3, colour: 4, rotation: 4, shading: 3 }
export type RuleKind = 'fixed' | 'constant' | 'progression' | 'distribute' | 'logic'

export interface Figure { shape: number; count: number; size: number; colour: number; rotation: number; shading: number; /** 4-bit dot mask, 0 when the puzzle has no overlay */ mask: number }
export type FigureKey = keyof Figure
export const FIGURE_KEYS: FigureKey[] = [...ATTRS, 'mask']

export interface RuleUse { attr: FigureKey; kind: RuleKind; /** progression step, or 0/1 for logic xor/and */ detail: number }
export interface MatrixPuzzle {
  /** Row-major cells 0..7 (the ninth is the answer). */
  cells: Figure[]
  options: Figure[]
  correct: number
  rules: RuleUse[]
  /** For each option, the attributes in which it differs from the right figure (empty for the right one). */
  changed: FigureKey[][]
  overlay: boolean
}

export interface MatrixParams { rules: number; options: number; similarity: number; overlay: number }

const sameFigure = (a: Figure, b: Figure) => FIGURE_KEYS.every(key => a[key] === b[key])
const domainOf = (key: FigureKey) => (key === 'mask' ? 16 : DOMAIN[key])

// ---- building the grid of one attribute ------------------------------------------------------------------------------------
function validStarts(domain: number, step: number): number[] {
  const starts: number[] = []
  for (let s = 0; s < domain; s++) if (s + 2 * step >= 0 && s + 2 * step < domain) starts.push(s)
  return starts
}

/** The nine values (row-major) of one attribute under a rule. */
function buildGrid(rng: Rng, key: FigureKey, kind: RuleKind, detail: number): number[] {
  const domain = domainOf(key)
  const grid: number[] = []
  if (kind === 'fixed') { const v = rng.int(0, domain - 1); return Array(9).fill(v) }
  if (kind === 'constant') {
    const rows = rng.shuffle(Array.from({ length: domain }, (_, i) => i)).slice(0, 3)
    for (const row of rows) grid.push(row, row, row)
    return grid
  }
  if (kind === 'progression') {
    for (let r = 0; r < 3; r++) { const s = rng.pick(validStarts(domain, detail)); grid.push(s, s + detail, s + 2 * detail) }
    return grid
  }
  if (kind === 'distribute') {
    const set = rng.shuffle(Array.from({ length: domain }, (_, i) => i)).slice(0, 3)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) grid.push(set[(r + c) % 3])
    return grid
  }
  // logic: masks 1..14 so neither full nor empty; third = a op b (xor, or and)
  for (let r = 0; r < 3; r++) {
    let a = 0, b = 0, c = 0
    for (let tries = 0; tries < 30; tries++) {
      a = rng.int(1, 14); b = rng.int(1, 14); c = detail === 0 ? a ^ b : a & b
      if (c >= 1 && c <= 14 && a !== b) break
    }
    grid.push(a, b, c)
  }
  return grid
}

// ---- the rule solver -------------------------------------------------------------------------------------------------------
/** The values the rules that fit the eight visible cells give for the ninth, per rule kind. One value in total = unambiguous. */
export function predictions(known: number[], key: FigureKey, overlay: boolean): Array<{ kind: RuleKind; detail: number; value: number }> {
  const domain = domainOf(key)
  const row = (r: number) => [known[r * 3], known[r * 3 + 1], known[r * 3 + 2]]
  const r0 = row(0), r1 = row(1), r2 = [known[6], known[7]]
  const out: Array<{ kind: RuleKind; detail: number; value: number }> = []
  if (key === 'mask') {
    if (!overlay) return []
    for (const [detail, op] of [[0, (a: number, b: number) => a ^ b], [1, (a: number, b: number) => a & b]] as const) {
      if (op(r0[0], r0[1]) === r0[2] && op(r1[0], r1[1]) === r1[2]) out.push({ kind: 'logic', detail, value: op(r2[0], r2[1]) })
    }
    return out
  }
  if (known.every(v => v === known[0])) out.push({ kind: 'fixed', detail: 0, value: known[0] })
  if (r0[0] === r0[1] && r0[1] === r0[2] && r1[0] === r1[1] && r1[1] === r1[2] && r2[0] === r2[1]) out.push({ kind: 'constant', detail: 0, value: r2[0] })
  for (const d of [1, 2, -1, -2]) {
    const fits = (r: number[]) => r[1] - r[0] === d && (r.length < 3 || r[2] - r[1] === d)
    if (fits(r0) && fits(r1) && fits(r2) && r2[1] + d >= 0 && r2[1] + d < domain) out.push({ kind: 'progression', detail: d, value: r2[1] + d })
  }
  const triple = (r: number[]) => new Set(r).size === 3
  const sameSet = (a: number[], b: number[]) => a.every(v => b.includes(v))
  if (triple(r0) && triple(r1) && sameSet(r0, r1) && r2[0] !== r2[1] && r0.includes(r2[0]) && r0.includes(r2[1])) out.push({ kind: 'distribute', detail: 0, value: r0.find(v => v !== r2[0] && v !== r2[1]) as number })
  return out
}

/** True when every attribute of the matrix has exactly one predicted value for the ninth cell, and it is the intended one. */
export function isUnambiguous(grids: Record<FigureKey, number[]>, overlay: boolean): boolean {
  for (const key of FIGURE_KEYS) {
    if (key === 'mask' && !overlay) continue
    const found = predictions(grids[key].slice(0, 8), key, overlay)
    const values = new Set(found.map(p => p.value))
    if (values.size !== 1 || !values.has(grids[key][8])) return false
  }
  return true
}

// ---- the puzzle ------------------------------------------------------------------------------------------------------------
const KINDS: RuleKind[] = ['constant', 'progression', 'distribute']

function figureAt(grids: Record<FigureKey, number[]>, index: number): Figure {
  return Object.fromEntries(FIGURE_KEYS.map(key => [key, grids[key][index]])) as unknown as Figure
}

function makeDistractor(rng: Rng, answer: Figure, ruled: FigureKey[], overlay: boolean, one: boolean): { figure: Figure; changed: FigureKey[] } {
  const keys = FIGURE_KEYS.filter(key => key !== 'mask' || overlay)
  const count = one ? 1 : rng.int(2, Math.min(3, keys.length))
  // Changing a ruled attribute is the more plausible mistake, so it is picked more often.
  const weighted = [...keys, ...ruled]
  const picked = new Set<FigureKey>()
  for (let guard = 0; picked.size < count && guard < 40; guard++) picked.add(rng.pick(weighted))
  const figure = { ...answer }
  for (const key of picked) {
    const domain = domainOf(key)
    let value = figure[key]
    for (let guard = 0; value === answer[key] && guard < 20; guard++) value = key === 'mask' ? rng.int(1, 14) : rng.int(0, domain - 1)
    figure[key] = value
  }
  return { figure, changed: [...picked].filter(key => figure[key] !== answer[key]) }
}

export function generateMatrix(rng: Rng, params: MatrixParams): MatrixPuzzle {
  const overlay = params.overlay >= 1
  for (let attempt = 0; attempt < 60; attempt++) {
    const ruledAttrs = rng.shuffle([...ATTRS]).slice(0, Math.max(1, Math.min(ATTRS.length, Math.round(params.rules))))
    const rules: RuleUse[] = []
    const grids = {} as Record<FigureKey, number[]>
    for (const key of FIGURE_KEYS) {
      if (key === 'mask') {
        const detail = rng.int(0, 1)
        grids.mask = overlay ? buildGrid(rng, 'mask', 'logic', detail) : Array(9).fill(0)
        if (overlay) rules.push({ attr: 'mask', kind: 'logic', detail })
        continue
      }
      if (!ruledAttrs.includes(key)) { grids[key] = buildGrid(rng, key, 'fixed', 0); continue }
      const kind = rng.pick(KINDS.filter(k => k !== 'progression' || DOMAIN[key] >= 3))
      const detail = kind === 'progression' ? rng.pick([1, 1, 2, -1, -2].filter(d => validStarts(DOMAIN[key], d).length > 0)) : 0
      grids[key] = buildGrid(rng, key, kind, detail)
      rules.push({ attr: key, kind, detail })
    }
    if (!isUnambiguous(grids, overlay)) continue
    const cells = Array.from({ length: 8 }, (_, i) => figureAt(grids, i))
    const answer = figureAt(grids, 8)
    if (cells.some(cell => sameFigure(cell, answer)) && attempt < 40) continue // a visible twin of the answer would make the picture dull
    const optionCount = Math.max(3, Math.round(params.options))
    const options: Array<{ figure: Figure; changed: FigureKey[] }> = [{ figure: answer, changed: [] }]
    for (let guard = 0; options.length < optionCount && guard < 200; guard++) {
      const candidate = makeDistractor(rng, answer, rules.map(rule => rule.attr), overlay, rng.chance(params.similarity))
      if (candidate.changed.length && !options.some(option => sameFigure(option.figure, candidate.figure))) options.push(candidate)
    }
    if (options.length < optionCount) continue
    const order = rng.shuffle(options.map((_, i) => i))
    const shuffled = order.map(i => options[i])
    return { cells, options: shuffled.map(o => o.figure), changed: shuffled.map(o => o.changed), correct: order.indexOf(0), rules, overlay }
  }
  throw new Error('Could not build an unambiguous matrix')
}

/** For the finished puzzle: no option except the right one satisfies every attribute's rule. */
export function distractorsAreWrong(puzzle: MatrixPuzzle): boolean {
  const known = (key: FigureKey) => puzzle.cells.map(cell => cell[key])
  const predicted = new Map<FigureKey, number>()
  for (const key of FIGURE_KEYS) {
    if (key === 'mask' && !puzzle.overlay) continue
    const values = new Set(predictions(known(key), key, puzzle.overlay).map(p => p.value))
    if (values.size !== 1) return false
    predicted.set(key, [...values][0])
  }
  const satisfying = puzzle.options.map(option => [...predicted].every(([key, value]) => option[key] === value))
  return satisfying.filter(Boolean).length === 1 && satisfying[puzzle.correct]
}

export interface GenerateMatrixArgs { params: Record<string, number>; seed: number; count: number }
export function generateMatrices({ params, seed, count }: GenerateMatrixArgs): MatrixPuzzle[] {
  const rng = createRng(seed)
  const spec: MatrixParams = { rules: params.rules, options: params.options, similarity: params.similarity, overlay: params.overlay }
  return Array.from({ length: count }, () => generateMatrix(rng, spec))
}

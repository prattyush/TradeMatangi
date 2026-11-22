import { beforeAll, describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { WORD_LADDER_PARAMS } from '../../config/difficulty.brain'
import { loadWordData, type WordData } from '../../words/loader'
import { createWordLadderEngine, HINT_COST, puzzleScore, stepsOf, summariseWordLadder, type WlResponse, type WlTrial } from './engine'
import { buildLadderGraph, distancesFrom, generateLadder, oneLetterApart, shortestPath, type LadderPuzzle } from './generator'

let data: WordData
beforeAll(async () => { data = await loadWordData() })
const params = (level: number) => paramsAt(WORD_LADDER_PARAMS, level)
const make = (level: number, seed = 1) => generateLadder(data, createRng(seed), { length: params(level).length, par: params(level).par })

describe('Word Ladder graph', () => {
  const words = ['cat', 'cot', 'cut', 'cog', 'dog', 'dot', 'dig', 'dug', 'bat', 'bag', 'big', 'zzz']
  it('neighbours are exactly the words one letter apart (wildcard buckets agree with a pairwise check)', () => {
    const graph = buildLadderGraph(words)
    for (let i = 0; i < words.length; i++) {
      const expected = words.map((w, j) => (oneLetterApart(words[i], w) ? j : -1)).filter(j => j >= 0).sort((a, b) => a - b)
      expect([...graph.neighbours[i]].sort((a, b) => a - b)).toEqual(expected)
    }
  })
  it('distances equal an independent Floyd-Warshall on a small graph; unreachable is -1', () => {
    const graph = buildLadderGraph(words)
    const n = words.length, d = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : oneLetterApart(words[i], words[j]) ? 1 : 1e9)))
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) d[i][j] = Math.min(d[i][j], d[i][k] + d[k][j])
    for (let i = 0; i < n; i++) { const dist = distancesFrom(graph, i); for (let j = 0; j < n; j++) expect(dist[j]).toBe(d[i][j] >= 1e9 ? -1 : d[i][j]) }
    expect(shortestPath(graph, 'cat', 'dog')).toHaveLength(distancesFrom(graph, graph.index.get('cat') as number)[graph.index.get('dog') as number] + 1)
    expect(shortestPath(graph, 'cat', 'zzz')).toBeNull()
  })
  it('one-letter-apart means same length and exactly one different position', () => {
    expect(oneLetterApart('cat', 'cot')).toBe(true); expect(oneLetterApart('cat', 'cat')).toBe(false); expect(oneLetterApart('cat', 'dog')).toBe(false); expect(oneLetterApart('cat', 'cats')).toBe(false)
  })
})

describe('Word Ladder generator', () => {
  it('is deterministic for a seed', () => { expect(make(5, 3)).toEqual(make(5, 3)); expect(make(5, 3)).not.toEqual(make(5, 4)) })
  it.each([1, 5, 10, 15, 20])('level %i: par equals the BFS shortest path over the common words, the path is valid, the endpoints are common', level => {
    for (const seed of [1, 2, 3]) {
      const p = make(level, seed), want = params(level)
      expect(p.start).toHaveLength(Math.round(want.length)); expect(p.goal).toHaveLength(Math.round(want.length))
      expect(data.commonSet.has(p.start) && data.commonSet.has(p.goal)).toBe(true)
      const graph = buildLadderGraph(p.common)
      expect(distancesFrom(graph, graph.index.get(p.start) as number)[graph.index.get(p.goal) as number]).toBe(p.par)
      expect(p.path).toHaveLength(p.par + 1)
      expect(p.path[0]).toBe(p.start); expect(p.path[p.path.length - 1]).toBe(p.goal)
      for (let i = 1; i < p.path.length; i++) expect(oneLetterApart(p.path[i - 1], p.path[i])).toBe(true)
      expect(p.path.every(w => data.validSet.has(w))).toBe(true)
      expect(p.valid.every(w => w.length === p.length && data.validSet.has(w))).toBe(true)
      // the requested par is met whenever the graph has such a pair (it does at these levels)
      expect(p.par).toBe(Math.round(want.par))
    }
  })
  it('levels lengthen the words and raise par (3 letters par 3 at level 1, 5 letters par 8 at level 20)', () => {
    expect(make(1).length).toBe(3); expect(make(1).par).toBe(3); expect(make(20).length).toBe(5)
  })
  it('puzzles of one session start from different words', () => {
    const used = new Set<string>(), rng = createRng(2), starts: string[] = []
    for (let i = 0; i < 5; i++) { const p = generateLadder(data, rng, { length: 4, par: 5 }, used); used.add(p.start); starts.push(p.start) }
    expect(new Set(starts).size).toBe(5)
  })
  it('generation is quick', () => { const t = performance.now(); make(20, 5); make(10, 5); expect(performance.now() - t).toBeLessThan(2000) })
})

describe('Word Ladder engine and scoring', () => {
  const play = (level: number, answer: (t: WlTrial) => WlResponse | 'timeout') => {
    const puzzles: LadderPuzzle[] = [1, 2, 3, 4, 5].map(seed => make(level, seed))
    const engine = createWordLadderEngine(params(level), createRng(3), puzzles)
    const log: TrialLogEntry<WlTrial, WlResponse>[] = []
    for (let t = engine.next(); t !== null; t = engine.next()) {
      const response = answer(t)
      log.push({ n: log.length + 1, trial: t, response, rtMs: response === 'timeout' ? null : 40000, outcome: engine.evaluate(t, response, 40000), atMs: log.length })
    }
    return log
  }
  const par = (t: WlTrial): WlResponse => ({ words: t.puzzle.path, hints: 0, solved: true })
  it('deals five puzzles', () => { expect(play(5, par)).toHaveLength(5) })
  it('a solved puzzle scores par / steps minus 0.2 per hint; unsolved and timed out score 0', () => {
    const [entry] = play(5, par)
    const p = entry.trial.puzzle.par
    expect(puzzleScore(entry)).toBe(1)
    const longer = { ...entry, response: { words: [...entry.trial.puzzle.path, 'x'], hints: 0, solved: true } as WlResponse }
    expect(stepsOf(longer.response)).toBe(p + 1)
    expect(puzzleScore(longer)).toBeCloseTo(p / (p + 1), 6)
    expect(puzzleScore({ ...entry, response: { ...(entry.response as WlResponse), hints: 2 } })).toBeCloseTo(1 - 2 * HINT_COST, 6)
    expect(puzzleScore({ ...entry, response: { ...(entry.response as WlResponse), hints: 9 } })).toBe(0)
    expect(puzzleScore({ ...entry, response: { words: [entry.trial.puzzle.start], hints: 0, solved: false } })).toBe(0)
    expect(puzzleScore({ ...entry, response: 'timeout' })).toBe(0)
  })
  it('a shorter obscure route cannot beat 1 (the score is capped)', () => {
    const [entry] = play(5, par)
    expect(puzzleScore({ ...entry, response: { words: [entry.trial.puzzle.start, entry.trial.puzzle.goal], hints: 0, solved: true } })).toBe(1)
  })
  it('all five at par scores 100; solving two of five at par scores 40; nothing scores 0', () => {
    expect(summariseWordLadder(play(5, par), 5).score).toBe(100)
    let n = 0
    expect(summariseWordLadder(play(5, t => (n++ < 2 ? par(t) : 'timeout')), 5).score).toBe(40)
    expect(summariseWordLadder(play(5, () => 'timeout'), 5).score).toBe(0)
  })
  it('reports mean steps against par, solve rate and hints, within 20 keys; the review shows the shortest route', () => {
    const summary = summariseWordLadder(play(5, par), 5)
    expect(summary.stats).toMatchObject({ puzzles: 5, solved: 5, solve_rate_pct: 100, hints_used: 0 })
    expect(summary.stats!.mean_steps).toBe(summary.stats!.mean_par)
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20)
    expect(summary.review![0].correctAnswer).toContain(' > ')
  })
})

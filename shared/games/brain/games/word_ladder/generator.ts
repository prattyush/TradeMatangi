/**
 * Word Ladder generator (spec 17.5 #21, corrections C4). The neighbour graph is built from the COMMON list by wildcard buckets
 * (`c_t` -> cat, cot, cut); the par of a puzzle is the shortest path in that graph. Steps the player takes may be any VALID word of
 * the same length that differs in one letter. Seeded.
 */
import { createRng, type Rng } from '../../../core/rng'
import type { WordData } from '../../words/loader'

export interface LadderGraph { words: string[]; index: Map<string, number>; neighbours: number[][] }

/** Neighbours by wildcard bucket: two words are neighbours when they match with one position replaced by `_`. */
export function buildLadderGraph(words: readonly string[]): LadderGraph {
  const index = new Map(words.map((word, i) => [word, i]))
  const buckets = new Map<string, number[]>()
  words.forEach((word, i) => {
    for (let p = 0; p < word.length; p++) {
      const key = word.slice(0, p) + '_' + word.slice(p + 1)
      const list = buckets.get(key)
      if (list) list.push(i); else buckets.set(key, [i])
    }
  })
  const neighbours: number[][] = words.map(() => [])
  for (const list of buckets.values()) for (const a of list) for (const b of list) if (a !== b) neighbours[a].push(b)
  return { words: [...words], index, neighbours }
}

/** Distances from `from` to every word (-1 = unreachable). */
export function distancesFrom(graph: LadderGraph, from: number): Int32Array {
  const dist = new Int32Array(graph.words.length).fill(-1)
  dist[from] = 0
  const queue = [from]
  for (let head = 0; head < queue.length; head++) for (const next of graph.neighbours[queue[head]]) if (dist[next] === -1) { dist[next] = dist[queue[head]] + 1; queue.push(next) }
  return dist
}

/** One shortest path of words from `from` to `to`, or null when there is none (they are in different parts of the graph). */
export function shortestPath(graph: LadderGraph, from: string, to: string): string[] | null {
  const start = graph.index.get(from), goal = graph.index.get(to)
  if (start === undefined || goal === undefined) return null
  const previous = new Int32Array(graph.words.length).fill(-2)
  previous[start] = -1
  const queue = [start]
  for (let head = 0; head < queue.length && previous[goal] === -2; head++) for (const next of graph.neighbours[queue[head]]) if (previous[next] === -2) { previous[next] = queue[head]; queue.push(next) }
  if (previous[goal] === -2) return null
  const path: string[] = []
  for (let at = goal; at !== -1; at = previous[at]) path.push(graph.words[at])
  return path.reverse()
}

export const oneLetterApart = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false
  return diff === 1
}

export interface LadderPuzzle {
  start: string
  goal: string
  /** Shortest path length in steps (words after the start) over the common graph. */
  par: number
  length: number
  /** One shortest path (start ... goal), for the review. */
  path: string[]
  /** The common words of this length (the graph hints use). */
  common: string[]
  /** Every valid word of this length: what a step may be. */
  valid: string[]
}

export interface LadderParams { length: number; par: number }

export function generateLadder(data: WordData, rng: Rng, params: LadderParams, avoid: Set<string> = new Set()): LadderPuzzle {
  const length = Math.round(params.length), want = Math.round(params.par)
  const common = data.common.filter(entry => entry.tier === 1 && entry.word.length === length).map(entry => entry.word)
  const valid = data.valid.filter(word => word.length === length)
  const graph = buildLadderGraph(common)
  // Words with neighbours only: an isolated word has no ladder.
  const starts = graph.words.filter((_, i) => graph.neighbours[i].length >= 2)
  let best: { start: number; goal: number; par: number } | null = null
  for (let attempt = 0; attempt < 60; attempt++) {
    const start = graph.index.get(rng.pick(starts)) as number
    if (avoid.has(graph.words[start])) continue
    const dist = distancesFrom(graph, start)
    let max = 0
    const candidates: number[] = []
    for (let i = 0; i < dist.length; i++) if (dist[i] === want) candidates.push(i)
    if (candidates.length) { best = { start, goal: rng.pick(candidates), par: want }; break }
    for (let i = 0; i < dist.length; i++) if (dist[i] > max) max = dist[i]
    if (max > 0 && (!best || Math.abs(max - want) < Math.abs(best.par - want))) {
      const far: number[] = []
      for (let i = 0; i < dist.length; i++) if (dist[i] === max) far.push(i)
      best = { start, goal: rng.pick(far), par: max }
    }
  }
  const chosen = best as { start: number; goal: number; par: number }
  const startWord = graph.words[chosen.start], goalWord = graph.words[chosen.goal]
  return { start: startWord, goal: goalWord, par: chosen.par, length, path: shortestPath(graph, startWord, goalWord) as string[], common, valid }
}

export interface GenerateLadderArgs { params: Record<string, number>; seed: number; count: number }
export async function generateLadderSet({ params, seed, count }: GenerateLadderArgs): Promise<LadderPuzzle[]> {
  const { loadWordData } = await import('../../words/loader')
  const data = await loadWordData()
  const rng = createRng(seed)
  const out: LadderPuzzle[] = []
  const used = new Set<string>()
  for (let i = 0; i < count; i++) { const puzzle = generateLadder(data, rng, { length: params.length, par: params.par }, used); used.add(puzzle.start); out.push(puzzle) }
  return out
}

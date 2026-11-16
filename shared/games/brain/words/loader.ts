/// <reference path="./raw.d.ts" />
/**
 * Lazy loading of the word lists (spec 17.6): the files are text assets imported with `import()` only here, so they are in their
 * own chunk (or inside the words worker) and never in the main bundle, the trading window or the other games. The decoded lists
 * are cached for the life of the page or worker and released with `releaseWordData()`.
 */
import { buildTrie, decodeFrontCoded, decodeTiered, type TieredWord, type Trie } from './wordlist'

export interface WordData {
  /** Every accepted word, sorted. */
  valid: string[]
  validSet: ReadonlySet<string>
  /** The common list (tiers 1 to 3), sorted by word. */
  common: TieredWord[]
  /** Common words of tier 1 only (targets, ladder graph and endpoints, Letter Grid denominator). */
  commonSet: ReadonlySet<string>
  /** The trie of the valid list, built on first use. */
  trie(): Trie
}

let cached: Promise<WordData> | null = null

export function loadWordData(): Promise<WordData> {
  cached ??= (async () => {
    const [validText, commonText] = await Promise.all([
      import('../assets/words/valid.fc.txt?raw').then(module => module.default),
      import('../assets/words/common.fc.txt?raw').then(module => module.default),
    ])
    const valid = decodeFrontCoded(validText)
    const common = decodeTiered(commonText)
    let trie: Trie | null = null
    return {
      valid, validSet: new Set(valid), common, commonSet: new Set(common.filter(entry => entry.tier === 1).map(entry => entry.word)),
      trie: () => (trie ??= buildTrie(valid)),
    }
  })()
  return cached
}

/** Forget the decoded lists (the Games workspace closed, or a generator finished on the calling thread). */
export function releaseWordData(): void { cached = null }

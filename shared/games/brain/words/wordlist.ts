/**
 * Word lists for the Word games (spec 17.6): decoding the shipped front-coded files and a typed-array trie. Pure; the files
 * themselves are loaded lazily by `loader.ts`.
 *
 * Front coding: each line is one character (0-9, a-z = 0 to 35) for the length of the prefix shared with the previous word, then
 * the rest of the word; the common list adds a tier digit (1 to 3) as the last character of the line.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function decodeFrontCoded(text: string): string[] {
  const words: string[] = []
  let previous = ''
  for (const line of text.split('\n')) {
    if (!line) continue
    const word = previous.slice(0, ALPHABET.indexOf(line[0])) + line.slice(1)
    words.push(word)
    previous = word
  }
  return words
}

export interface TieredWord { word: string; /** 1 = common, 2 and 3 = less common */ tier: number }

export function decodeTiered(text: string): TieredWord[] {
  // The tier digit is the last character of a line and not part of the word, so it never joins the shared prefix.
  const words: TieredWord[] = []
  let previous = ''
  for (const line of text.split('\n')) {
    if (!line) continue
    const body = line.slice(1, -1), tier = Number(line[line.length - 1])
    const word = previous.slice(0, ALPHABET.indexOf(line[0])) + body
    words.push({ word, tier })
    previous = word
  }
  return words
}

/** A trie in typed arrays (first child / next sibling), about 5 MB for the whole valid list: an object per node would be 40 MB or more. */
export interface Trie {
  readonly size: number
  /** Letter of the node as 0..25 (the root has none). */
  readonly letter: Uint8Array
  readonly firstChild: Int32Array
  readonly nextSibling: Int32Array
  readonly terminal: Uint8Array
  /** The child of `node` for letter code 0..25, or -1. */
  step(node: number, code: number): number
  /** True when `node` ends a word. */
  isWord(node: number): boolean
  /** The node of a whole word, or -1. */
  find(word: string): number
}

/** Builds a trie from words sorted ascending (a-z only). Because the input is sorted, a new node is always its parent's LAST child. */
export function buildTrie(sortedWords: readonly string[]): Trie {
  let total = 1
  let previous = ''
  for (const word of sortedWords) {
    let n = 0
    while (n < word.length && n < previous.length && word[n] === previous[n]) n++
    total += word.length - n
    previous = word
  }
  const letter = new Uint8Array(total)
  const firstChild = new Int32Array(total).fill(-1)
  const nextSibling = new Int32Array(total).fill(-1)
  const lastChild = new Int32Array(total).fill(-1)
  const terminal = new Uint8Array(total)
  const path: number[] = [0]
  let count = 1
  previous = ''
  for (const word of sortedWords) {
    let shared = 0
    while (shared < word.length && shared < previous.length && word[shared] === previous[shared]) shared++
    path.length = shared + 1
    for (let i = shared; i < word.length; i++) {
      const parent = path[i]
      const node = count++
      letter[node] = word.charCodeAt(i) - 97
      if (firstChild[parent] === -1) firstChild[parent] = node
      else nextSibling[lastChild[parent]] = node
      lastChild[parent] = node
      path.push(node)
    }
    terminal[path[word.length]] = 1
    previous = word
  }
  const step = (node: number, code: number) => {
    for (let child = firstChild[node]; child !== -1; child = nextSibling[child]) if (letter[child] === code) return child
    return -1
  }
  return {
    size: count, letter, firstChild, nextSibling, terminal, step,
    isWord: node => terminal[node] === 1,
    find(word) {
      let node = 0
      for (let i = 0; i < word.length && node !== -1; i++) node = step(node, word.charCodeAt(i) - 97)
      return node
    },
  }
}

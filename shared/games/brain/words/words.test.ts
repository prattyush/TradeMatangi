import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadWordData, releaseWordData } from './loader'
import { buildTrie, decodeFrontCoded, decodeTiered } from './wordlist'

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '../assets/words')
const text = (name: string) => readFileSync(join(assets, name), 'utf8')
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const encode = (words: string[], tiers?: number[]) => {
  let previous = ''
  return words.map((word, i) => {
    let n = 0
    while (n < Math.min(word.length, previous.length) && word[n] === previous[n]) n++
    previous = word
    return ALPHABET[n] + word.slice(n) + (tiers ? tiers[i] : '')
  }).join('\n') + '\n'
}
const valid = decodeFrontCoded(text('valid.fc.txt'))
const common = decodeTiered(text('common.fc.txt'))
const excluded = text('exclude.txt').split('\n').filter(Boolean)
const sorted = (list: string[]) => list.every((word, i) => i === 0 || list[i - 1] < word)

describe('word-list assets (spec 17.6)', () => {
  it('both lists are sorted, unique, a-z only, with the right lengths and tier digits', () => {
    expect(sorted(valid)).toBe(true)
    expect(valid.every(word => /^[a-z]+$/.test(word) && word.length >= 2)).toBe(true)
    expect(sorted(common.map(entry => entry.word))).toBe(true)
    expect(common.every(entry => /^[a-z]{3,9}$/.test(entry.word) && [1, 2, 3].includes(entry.tier))).toBe(true)
  })
  it('the lists are as large as planned: over 150k valid words, tier 1 at least 20k common words', () => {
    expect(valid.length).toBeGreaterThan(150000)
    expect(common.filter(entry => entry.tier === 1).length).toBeGreaterThan(20000)
    expect(common.length).toBeGreaterThan(45000)
  })
  it('common is inside valid, and the offensive words are in neither', () => {
    const validSet = new Set(valid)
    expect(common.every(entry => validSet.has(entry.word))).toBe(true)
    expect(excluded.length).toBeGreaterThan(100)
    expect(sorted(excluded)).toBe(true)
    for (const word of excluded) { expect(validSet.has(word), word).toBe(false) }
    const commonSet = new Set(common.map(entry => entry.word))
    for (const word of excluded) expect(commonSet.has(word), word).toBe(false)
    // the strong stems appear in no word at all, and SCOWL's own taboo list words are gone
    for (const stem of ['fuck', 'shit', 'cunt', 'nigg']) expect(valid.filter(word => word.includes(stem))).toEqual([])
    for (const word of ['asshole', 'bullshit', 'motherfucker', 'cocksucker']) expect(validSet.has(word)).toBe(false)
  })
  it('ordinary words are still there (a sanity check that the exclusion did not eat the list)', () => {
    const validSet = new Set(valid)
    for (const word of ['the', 'cat', 'cattle', 'assist', 'class', 'shell', 'scunthorpe'.slice(0, 5), 'color', 'favorite', 'center']) expect(validSet.has(word), word).toBe(word !== 'scunt')
  })
  it('the front-coded files decode to exactly what an independent encoder would write', () => {
    expect(encode(valid)).toBe(text('valid.fc.txt'))
    expect(encode(common.map(entry => entry.word), common.map(entry => entry.tier))).toBe(text('common.fc.txt'))
  })
  it('each list is within the size budget: at most 1.5 MB raw and 500 KB gzipped', () => {
    for (const name of ['valid.fc.txt', 'common.fc.txt']) {
      const raw = readFileSync(join(assets, name))
      expect(raw.length).toBeLessThanOrEqual(1.5 * 1024 * 1024)
      expect(gzipSync(raw, { level: 9 }).length).toBeLessThanOrEqual(500 * 1024)
    }
  })
  it('NOTICE records the SHA-256 of every shipped file, names ENABLE and SCOWL, quotes SCOWL\'s Copyright and says the files are modified', () => {
    const notice = text('NOTICE')
    const flat = notice.replace(/\s+/g, ' ')
    for (const name of ['valid.fc.txt', 'common.fc.txt', 'exclude.txt']) {
      const digest = createHash('sha256').update(readFileSync(join(assets, name))).digest('hex')
      expect(notice, name).toContain(digest)
    }
    expect(notice).toContain('3f16130220645692ed49c7134e24a18504c2ca55b3c012f7290e3e77c63b1a89') // ENABLE source
    expect(notice).toContain('5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc') // SCOWL source
    expect(notice).toContain('Copyright 2000-2018 by Kevin Atkinson')
    expect(flat).toContain('WordNet 1.6 Copyright 1997 by Princeton University')
    expect(notice).toContain('Geoff Kuenning')
    expect(flat).toContain('Please mention the source and credit us as originators of the list')
    expect(flat).toMatch(/modified versions/i)
  })
})

describe('typed-array trie', () => {
  const sample = ['a', 'ab', 'abc', 'abd', 'b', 'ba', 'bat', 'bath', 'bats', 'cat']
  it('finds exactly the words in it, and prefixes are nodes but not words', () => {
    const trie = buildTrie(sample)
    for (const word of sample) expect(trie.isWord(trie.find(word)), word).toBe(true)
    for (const word of ['abe', 'c', 'ca', 'batx', 'z', 'bathe']) expect(trie.find(word) === -1 || !trie.isWord(trie.find(word)), word).toBe(true)
    expect(trie.find('ca')).not.toBe(-1)
    expect(trie.isWord(trie.find('ca'))).toBe(false)
    expect(trie.size).toBe(1 + 'a ab abc abd b ba bat bath bats c ca cat'.split(' ').length)
  })
  it('agrees with a Set on the whole valid list, in typed arrays of a few MB', () => {
    const trie = buildTrie(valid)
    const set = new Set(valid)
    for (let i = 0; i < valid.length; i += 97) { expect(trie.isWord(trie.find(valid[i]))).toBe(true) }
    for (const probe of ['qwxz', 'zzzzzz', 'catt', 'cattlex', 'abcdefg']) expect(set.has(probe) === (trie.find(probe) !== -1 && trie.isWord(trie.find(probe)))).toBe(true)
    const bytes = trie.letter.byteLength + trie.firstChild.byteLength + trie.nextSibling.byteLength + trie.terminal.byteLength
    expect(bytes).toBeLessThan(10 * 1024 * 1024) // spec: well under 40 MB
    expect(trie.size).toBeLessThan(450000)
  })
})

describe('lazy loader', () => {
  it('decodes both lists, caches them, can release them, and gives the same data as the files', async () => {
    releaseWordData()
    const data = await loadWordData()
    expect(await loadWordData()).toBe(data)
    expect(data.valid).toEqual(valid)
    expect(data.common).toEqual(common)
    expect(data.commonSet.has('cat')).toBe(true)
    expect(data.trie()).toBe(data.trie())
    releaseWordData()
    expect(await loadWordData()).not.toBe(data)
  })
  it('the assets are imported in one place only, by dynamic import (so they stay out of the main bundle and the other games)', () => {
    const root = join(here, '..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name)
        if (statSync(file).isDirectory()) { if (name !== 'assets') walk(file); continue }
        if (!/\.(ts|tsx)$/.test(name) || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue
        const source = readFileSync(file, 'utf8')
        if (!source.includes('.fc.txt')) continue
        const rel = relative(root, file)
        if (rel !== join('words', 'loader.ts')) offenders.push(rel)
        else expect(source).toMatch(/import\('\.\.\/assets\/words\/valid\.fc\.txt\?raw'\)/)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})

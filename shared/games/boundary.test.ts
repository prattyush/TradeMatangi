/**
 * Import boundary and key-handler rules for Games (spec 3.4, 17.7, correction C8).
 *  - Nothing under shared/games may import trading code; the only imports allowed are React, other shared/games files, and
 *    (for desktop/website glue) the transport helpers listed below.
 *  - Brain games may import only the framework (`core`, `data`, `ui`) and other brain files, never `market/**`.
 *  - No Games code registers a global key handler on `window` or `document`; keys are handled on a focused root element.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const gamesDir = here

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}
const sources = (dir: string) => walk(dir).filter(file => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file))
const importsOf = (text: string): string[] => [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] ?? m[2] ?? m[3])

const ALLOWED_PACKAGES = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])

describe('boundary scanner self-check', () => {
  it('sees every import form, so a violation cannot slip through', () => {
    const text = "import a from '../../src/App'\nimport { b } from \"react\"\nexport * from './x'\nimport './games.css'\nconst c = await import('../trading/orders')\nimport type { T } from '../../../frontend/src/services/api'\n"
    expect(importsOf(text)).toEqual(['../../src/App', 'react', './x', './games.css', '../trading/orders', '../../../frontend/src/services/api'])
    expect(/(window|document)\s*\.\s*addEventListener\(\s*['"]key/.test("window.addEventListener('keydown', f)")).toBe(true)
    expect(/(window|document)\s*\.\s*addEventListener\(\s*['"]key/.test("document.addEventListener('visibilitychange', f)")).toBe(false)
  })
})

describe('Games import boundary', () => {
  const files = sources(gamesDir)
  it('finds the Games sources', () => { expect(files.length).toBeGreaterThan(10) })

  it('imports only React and files inside shared/games (CSS included)', () => {
    const bad: string[] = []
    for (const file of files) {
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec)
          if (!target.startsWith(gamesDir + sep) && target !== gamesDir) bad.push(`${relative(root, file)} -> ${spec}`)
        } else if (!ALLOWED_PACKAGES.has(spec)) bad.push(`${relative(root, file)} -> ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('brain games never import market code, chart code or market data', () => {
    const bad: string[] = []
    for (const file of files.filter(f => relative(gamesDir, f).split(sep)[0] === 'brain')) {
      for (const spec of importsOf(readFileSync(file, 'utf8')).filter(s => s.startsWith('.'))) {
        const target = relative(gamesDir, resolve(dirname(file), spec)).split(sep)[0]
        if (['market', 'chart'].includes(target)) bad.push(`${relative(root, file)} -> ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('has no global key handlers and no direct network calls', () => {
    const bad: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (/(window|document)\s*\.\s*addEventListener\(\s*['"]key/.test(text)) bad.push(`${relative(root, file)}: global key listener`)
      if (/\bonkey(down|up|press)\s*=/.test(text) && /(window|document)\s*\.\s*onkey/.test(text)) bad.push(`${relative(root, file)}: global onkey*`)
      if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(text)) bad.push(`${relative(root, file)}: network call (use the injected transport)`)
    }
    expect(bad).toEqual([])
  })
})

describe('Host glue stays small and trading-free', () => {
  const glue: Array<[string, string[]]> = [
    ['windowsapp/src/GamesWindow.tsx', ['react', '@tauri-apps/api/core', './gamesApi']],
    ['windowsapp/src/gamesApi.ts', []],
    ['frontend/src/services/gamesRequest.ts', ['../config', './api']],
    ['frontend/src/components/games/GamesWorkspace.tsx', ['react', '../../services/gamesRequest']],
  ]
  for (const [file, allowed] of glue) {
    it(`${file} imports only the Games code and ${allowed.join(', ') || 'nothing else'}`, () => {
      const specs = importsOf(readFileSync(resolve(root, file), 'utf8'))
      const outside = specs.filter(spec => !allowed.includes(spec) && !/(^|\/)shared\/games\//.test(spec))
      expect(outside).toEqual([])
    })
  }
})

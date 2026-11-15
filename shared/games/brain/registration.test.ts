import { describe, expect, it } from 'vitest'
import { gamesIn } from '../core/ids'
import { getGame, isPlayable, registeredIds } from '../core/registry'
import '../games'

describe('registered brain games', () => {
  it('the three Speed games are registered and playable; the rest stay "Coming soon"', () => {
    expect(registeredIds().sort()).toEqual(['colour_clash', 'green_light', 'quick_match'])
    for (const entry of gamesIn('brain')) expect(isPlayable(entry.id)).toBe(['quick_match', 'colour_clash', 'green_light'].includes(entry.id))
  })
  it('each is a timed trial game with instructions, an RT range and a View', () => {
    for (const id of ['quick_match', 'colour_clash', 'green_light'] as const) {
      const game = getGame(id)!
      expect(game.kind).toBe('trial')
      if (game.kind !== 'trial') continue
      expect(game.session.kind).toBe('timed')
      expect(game.instructions.length).toBeGreaterThan(2); expect(game.instructions.length).toBeLessThanOrEqual(6)
      expect(Object.keys(game.paramTable)).toEqual(expect.arrayContaining(['rtFast', 'rtSlow']))
      expect(typeof game.View).toBe('function')
    }
  })
  it('every parameter is defined at every level 1 to 20 and finite', async () => {
    const { paramsAt } = await import('../core/difficulty')
    for (const id of ['quick_match', 'colour_clash', 'green_light'] as const) {
      for (let level = 1; level <= 20; level++) {
        const params = paramsAt(getGame(id)!.paramTable, level)
        for (const [key, value] of Object.entries(params)) expect(Number.isFinite(value), `${id} L${level} ${key}`).toBe(true)
        expect(params.rtFast).toBeLessThan(params.rtSlow)
      }
    }
  })
})

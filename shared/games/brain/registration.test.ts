import { describe, expect, it } from 'vitest'
import { gamesIn } from '../core/ids'
import { getGame, isPlayable, registeredIds } from '../core/registry'
import '../games'

describe('registered brain games', () => {
  const PLAYABLE = ['quick_match', 'colour_clash', 'green_light', 'grid_recall', 'sequence_echo', 'n_back_stream', 'flanker_flock', 'needle_finder', 'track_the_dots', 'rule_switch', 'card_sorter', 'flip_map', 'number_sprint', 'equation_drop', 'make_target', 'pattern_matrix', 'number_series', 'code_breaker', 'anagram_dash', 'letter_grid', 'word_ladder'] as const
  // Games scored on reaction time carry the RT_fast / RT_slow scale; recall and tracking games do not need one.
  const REACTION_TIME = ['quick_match', 'colour_clash', 'green_light', 'n_back_stream', 'flanker_flock', 'needle_finder', 'rule_switch', 'flip_map', 'number_sprint', 'equation_drop', 'make_target', 'pattern_matrix', 'number_series', 'code_breaker', 'anagram_dash', 'letter_grid', 'word_ladder'] as const
  it('the Speed, Memory, Attention, Flexibility, Math, Reasoning and Word games are registered and playable; the rest stay "Coming soon"', () => {
    expect(registeredIds().filter(id => gamesIn('brain').some(entry => entry.id === id)).sort()).toEqual([...PLAYABLE].sort())
    for (const entry of gamesIn('brain')) expect(isPlayable(entry.id)).toBe((PLAYABLE as readonly string[]).includes(entry.id))
  })
  it('each is a trial game with instructions and a View; timed blocks are the reaction-time games and n-back', () => {
    const timed = ['quick_match', 'colour_clash', 'green_light', 'n_back_stream', 'flanker_flock', 'rule_switch', 'flip_map', 'number_sprint', 'equation_drop', 'anagram_dash', 'letter_grid']
    for (const id of PLAYABLE) {
      const game = getGame(id)!
      expect(game.kind).toBe('trial')
      if (game.kind !== 'trial') continue
      expect(game.session.kind).toBe(timed.includes(id) ? 'timed' : 'rounds')
      expect(game.instructions.length).toBeGreaterThan(2); expect(game.instructions.length).toBeLessThanOrEqual(6)
      if ((REACTION_TIME as readonly string[]).includes(id)) expect(Object.keys(game.paramTable)).toEqual(expect.arrayContaining(['rtFast', 'rtSlow']))
      expect(typeof game.View).toBe('function')
    }
  })
  it('every parameter is defined at every level 1 to 20 and finite', async () => {
    const { paramsAt } = await import('../core/difficulty')
    for (const id of PLAYABLE) {
      for (let level = 1; level <= 20; level++) {
        const params = paramsAt(getGame(id)!.paramTable, level)
        for (const [key, value] of Object.entries(params)) expect(Number.isFinite(value), `${id} L${level} ${key}`).toBe(true)
        if (params.rtFast !== undefined) expect(params.rtFast).toBeLessThan(params.rtSlow)
      }
    }
  })
})

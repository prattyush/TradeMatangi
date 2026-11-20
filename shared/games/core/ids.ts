/** Phase 25 Games: ids, categories and the catalogue shown by the hub (no game logic lives here). */

export const MARKET_GAME_IDS = [
  'tick_reader', 'entry_sniper', 'exit_discipline', 'risk_calculator', 'hotkey_drill',
  'level_recall', 'regime_switch', 'strike_picker', 'spot_the_trap', 'no_trade_day',
] as const

export const BRAIN_GAME_IDS = [
  'quick_match', 'colour_clash', 'green_light', 'grid_recall', 'sequence_echo', 'n_back_stream',
  'flanker_flock', 'needle_finder', 'track_the_dots', 'rule_switch', 'card_sorter', 'flip_map',
  'number_sprint', 'equation_drop', 'make_target', 'pattern_matrix', 'number_series', 'code_breaker',
  'anagram_dash', 'letter_grid', 'word_ladder',
] as const

export type MarketGameId = typeof MARKET_GAME_IDS[number]
export type BrainGameId = typeof BRAIN_GAME_IDS[number]
export type GameId = MarketGameId | BrainGameId

export const ALL_GAME_IDS: readonly GameId[] = [...MARKET_GAME_IDS, ...BRAIN_GAME_IDS]

export const CATEGORIES = ['speed', 'memory', 'attention', 'flexibility', 'math', 'reasoning', 'discipline', 'word'] as const
export type Category = typeof CATEGORIES[number]

/** `market` = the ten trading-skill games (need cached market data); `brain` = the 21 general cognitive games (pure client). */
export type Pool = 'market' | 'brain'

export interface CatalogueEntry { id: GameId; title: string; category: Category; pool: Pool; blurb: string }

const m = (id: MarketGameId, title: string, category: Category, blurb: string): CatalogueEntry => ({ id, title, category, pool: 'market', blurb })
const b = (id: BrainGameId, title: string, category: Category, blurb: string): CatalogueEntry => ({ id, title, category, pool: 'brain', blurb })

export const CATALOGUE: readonly CatalogueEntry[] = [
  m('tick_reader', 'Tick Reader', 'speed', 'Read a short stretch of ticks and call the next move.'),
  m('entry_sniper', 'Entry Sniper', 'attention', 'Pick the clean entry, avoid the trap.'),
  m('exit_discipline', 'Exit Discipline', 'reasoning', 'Manage an open trade to its best exit.'),
  m('risk_calculator', 'Risk Calculator', 'math', 'Size positions and risk fast and correctly.'),
  m('hotkey_drill', 'Hotkey Drill', 'speed', 'Hit the right order keys under time pressure.'),
  m('level_recall', 'Level Recall', 'memory', 'Remember key levels, then place them.'),
  m('regime_switch', 'Regime Switch', 'flexibility', 'Change playbook when the market changes.'),
  m('strike_picker', 'Strike Picker', 'reasoning', 'Choose the right option strike for the scenario.'),
  m('spot_the_trap', 'Spot the Trap', 'attention', 'Spot the false signal among real ones.'),
  m('no_trade_day', 'No-Trade Day', 'discipline', 'Follow your rules and skip the bad setups.'),
  b('quick_match', 'Quick Match', 'speed', 'Same or different? Decide as fast as you can.'),
  b('colour_clash', 'Colour Clash', 'speed', 'Name the ink colour, not the word.'),
  b('green_light', 'Green Light', 'speed', 'Go on green, hold back on the rest.'),
  b('grid_recall', 'Grid Recall', 'memory', 'Remember which tiles lit up.'),
  b('sequence_echo', 'Sequence Echo', 'memory', 'Repeat the sequence in order.'),
  b('n_back_stream', 'N-Back Stream', 'memory', 'Spot when an item repeats from n steps back.'),
  b('flanker_flock', 'Flanker Flock', 'attention', 'Which way does the middle arrow point?'),
  b('needle_finder', 'Needle Finder', 'attention', 'Find the odd one out, or say it is not there.'),
  b('track_the_dots', 'Track the Dots', 'attention', 'Follow the marked dots as they move.'),
  b('rule_switch', 'Rule Switch', 'flexibility', 'Apply the rule the cue asks for.'),
  b('card_sorter', 'Card Sorter', 'flexibility', 'Work out the hidden rule, then adapt when it changes.'),
  b('flip_map', 'Flip Map', 'flexibility', 'Keys keep changing meaning; keep up.'),
  b('number_sprint', 'Number Sprint', 'math', 'Quick mental arithmetic.'),
  b('equation_drop', 'Equation Drop', 'math', 'Clear the falling equations before they land.'),
  b('make_target', 'Make Target', 'math', 'Reach the target from the numbers you are given.'),
  b('pattern_matrix', 'Pattern Matrix', 'reasoning', 'Find the piece that completes the pattern.'),
  b('number_series', 'Number Series', 'reasoning', 'What comes next in the series?'),
  b('code_breaker', 'Code Breaker', 'reasoning', 'Deduce the hidden code from the feedback.'),
  b('anagram_dash', 'Anagram Dash', 'word', 'Unscramble the letters.'),
  b('letter_grid', 'Letter Grid', 'word', 'Find words by chaining neighbouring letters.'),
  b('word_ladder', 'Word Ladder', 'word', 'Change one letter at a time to reach the goal word.'),
]

const byId = new Map<GameId, CatalogueEntry>(CATALOGUE.map(entry => [entry.id, entry]))
export const catalogueEntry = (id: GameId): CatalogueEntry => byId.get(id) as CatalogueEntry
export const isGameId = (value: unknown): value is GameId => typeof value === 'string' && byId.has(value as GameId)
export const gamesIn = (pool: Pool | 'all'): CatalogueEntry[] => CATALOGUE.filter(entry => pool === 'all' || entry.pool === pool)
export const CATEGORY_LABEL: Record<Category, string> = {
  speed: 'Speed', memory: 'Memory', attention: 'Attention', flexibility: 'Flexibility', math: 'Math', reasoning: 'Reasoning', discipline: 'Discipline', word: 'Word',
}

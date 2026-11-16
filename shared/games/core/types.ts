/** Game definition contracts (spec 4.1 and 17.3). The two kinds share the shell, difficulty, scoring, registry and hub. */
import type { ComponentType } from 'react'
import type { Category, GameId } from './ids'
import type { ParamTable } from './difficulty'
import type { Rng } from './rng'
import type { MarketHost } from '../market/host'
import type { ReviewRow, TrialEngine, TrialLogEntry } from './trial'

export type SessionMode = 'progress' | 'practice'

export interface SessionSummary {
  /** 0..100 integer. */
  score: number
  /** Small numeric stats saved on the game record (at most 20 keys, `[a-z0-9_]`). */
  stats?: Record<string, number>
  /** Optional trading-style extras that the day record keeps. */
  expectancyR?: number
  discipline?: number
  /** Per-trial review shown on the result screen (brain games). Kept on the device, never sent to the server. */
  review?: ReviewRow[]
}

/** What the shell hands a game's View. Kept deliberately small; B1/G3b extend it per kind. */
export interface GameViewProps {
  level: number
  mode: SessionMode
  params: Record<string, number>
  /** Seeded stream for this session. A View that must restart (React StrictMode) builds a fresh one from `seed`. */
  rng: Rng
  seed: number
  /** True while a dialog (quit?) is open over the game: a timed block treats it like losing focus. */
  suspended: boolean
  /** Market games only: cached market data and the player's cost settings. Brain games get nothing here. */
  market?: MarketHost
  /** The game calls this once with its result. */
  onFinish: (summary: SessionSummary) => void
  /** The shell owns Esc; a game that must stop (data failed to load) calls this instead. */
  onAbort: (reason: string) => void
}

interface DefinitionBase {
  id: GameId
  category: Category
  title: string
  blurb: string
  /** At most 6 lines on the instructions screen. */
  instructions: string[]
  /** Parameter tables from `config/difficulty*.json`, interpolated by `difficulty.ts`. */
  paramTable: ParamTable
  View: ComponentType<GameViewProps>
  /** Games whose difficulty is movement: the parameters to use when "Reduce motion" is on (slower, scoring unchanged). */
  reducedMotionParams?(params: Record<string, number>): Record<string, number>
}

/** Market games: rounds built from cached market data (Track G). */
export interface GameDefinition extends DefinitionBase {
  kind: 'market'
  roundsPerSession(level: number): number
}

/** Brain games: trial-based, usually a timed block (Track B). */
export interface TrialGameDefinition<Trial = unknown, R = unknown> extends DefinitionBase {
  kind: 'trial'
  session: { kind: 'timed'; seconds: number } | { kind: 'rounds'; count: (level: number) => number }
  createEngine(params: Record<string, number>, rng: Rng): TrialEngine<Trial, R>
  summarise(log: TrialLogEntry<Trial, R>[], level: number): SessionSummary
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGameDefinition = GameDefinition | TrialGameDefinition<any, any>

/** A timed block cannot be paused and ends on focus loss (spec 17.3). */
export const isTimedBlock = (definition: AnyGameDefinition): boolean => definition.kind === 'trial' && definition.session.kind === 'timed'

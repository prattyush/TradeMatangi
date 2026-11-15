/** Game definition contracts (spec 4.1 and 17.3). The two kinds share the shell, difficulty, scoring, registry and hub. */
import type { ComponentType } from 'react'
import type { Category, GameId } from './ids'
import type { ParamTable } from './difficulty'
import type { Rng } from './rng'

export type SessionMode = 'progress' | 'practice'

export interface SessionSummary {
  /** 0..100 integer. */
  score: number
  /** Small numeric stats saved on the game record (at most 20 keys, `[a-z0-9_]`). */
  stats?: Record<string, number>
  /** Optional trading-style extras that the day record keeps. */
  expectancyR?: number
  discipline?: number
}

/** What the shell hands a game's View. Kept deliberately small; B1/G3b extend it per kind. */
export interface GameViewProps {
  level: number
  mode: SessionMode
  params: Record<string, number>
  rng: Rng
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
}

/** Market games: rounds built from cached market data (Track G). */
export interface GameDefinition extends DefinitionBase {
  kind: 'market'
  roundsPerSession(level: number): number
}

/** Brain games: trial-based, usually a timed block (Track B). */
export interface TrialGameDefinition extends DefinitionBase {
  kind: 'trial'
  session: { kind: 'timed'; seconds: number } | { kind: 'rounds'; count: (level: number) => number }
}

export type AnyGameDefinition = GameDefinition | TrialGameDefinition

/** A timed block cannot be paused and ends on focus loss (spec 17.3). */
export const isTimedBlock = (definition: AnyGameDefinition): boolean => definition.kind === 'trial' && definition.session.kind === 'timed'

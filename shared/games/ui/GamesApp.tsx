import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CATEGORY_LABEL, CATEGORIES, gamesIn, type GameId, type Pool } from '../core/ids'
import type { GamesRequest } from '../core/client'
import { getGame, isPlayable } from '../core/registry'
import { levelBand } from '../core/difficulty'
import type { LocalSession } from '../core/dashboard'
import { newId, localDate } from '../core/uid'
import type { SessionResult } from '../core/progress'
import { applyPalette } from '../brain/ui/palette'
import { normalizeCost } from '../market/engine/costModel'
import { createMarketData } from '../market/data/marketData'
import { createWindowCache, DEFAULT_CACHE_BYTES, LOW_MEMORY_CACHE_BYTES } from '../market/data/windowCache'
import type { MarketHost } from '../market/host'
import { GameShell, type ShellDone } from './GameShell'
import { useProgress } from './useProgress'
import { useSessionLog } from './useSessionLog'
import { Dashboard } from './Dashboard'
import { Warmup, type RenderGameOptions } from './Warmup'
import { ReviewTab } from './ReviewTab'
import { SettingsPanel } from './SettingsPanel'
import '../games'
import './games.css'

export type SessionKind = 'none' | 'sim' | 'paper' | 'real'
type Tab = 'brain' | 'market' | 'dashboard' | 'warmup' | 'review' | 'settings'

export interface GamesAppProps {
  /** Transport to `/api/desktop/v1/games/*` (Rust command on the desktop, `fetch` on the website). */
  request: GamesRequest
  /** Whether a trading session is running next to this window (shows a banner only; Games never touches it). */
  sessionKind?: SessionKind
  /** Passed by hosts that embed Games as an overlay. */
  onClose?: () => void
}

const TAB_LABEL: Record<Tab, string> = { brain: 'Brain', market: 'Market', dashboard: 'Dashboard', warmup: 'Warm-up', review: 'Review', settings: 'Settings' }

export default function GamesApp({ request, sessionKind = 'none', onClose }: GamesAppProps) {
  const progress = useProgress(request)
  const sessionLog = useSessionLog()
  const [tab, setTab] = useState<Tab>('brain')
  const [playing, setPlaying] = useState<GameId | null>(null)
  const sessionNo = useRef(1)
  const settings = progress.settings
  const userId = progress.state.user_id ?? 'unknown'
  const today = localDate()

  useEffect(() => { applyPalette(settings.palette) }, [settings.palette])

  // One market-data object per launch (one availability fetch, one throttle, one cache); the cap follows the low-memory setting.
  const marketData = useMemo(() => createMarketData({ request, cache: createWindowCache(settings.lowMemory ? LOW_MEMORY_CACHE_BYTES : DEFAULT_CACHE_BYTES) }), [request, settings.lowMemory])
  const costKey = `${settings.slippagePtsPerSide}|${settings.roundTripCostPerLotRs}|${settings.defaultLots}`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const market = useMemo<MarketHost>(() => ({ data: marketData, cost: normalizeCost(settings), userId, today }), [marketData, costKey, userId, today])

  const finished = useCallback((id: GameId, done: ShellDone, extra: { warmupStep?: number; replay?: boolean }) => {
    sessionNo.current += 1
    if (extra.replay) return
    const playedAt = new Date().toISOString()
    const result: SessionResult = { id: newId(), gameId: id, mode: done.mode, level: done.level, date: localDate(), minutes: done.minutes, summary: done.summary, playedAt }
    if (extra.warmupStep) result.warmup = { step: extra.warmupStep }
    void progress.record(result)
    const local: LocalSession = { id: result.id, gameId: id, date: result.date, level: done.level, mode: done.mode, seed: done.seed, score: done.summary.score, stats: done.summary.stats, playedAt, review: done.summary.review }
    void sessionLog.add(local)
  }, [progress, sessionLog])

  /** One game inside the shared shell; the hub, Warm-up and Review all play through here so recording and settings stay in one place. */
  const renderGame = (id: GameId, options: RenderGameOptions & { replay?: { seed: number; level: number } }): ReactNode => {
    const definition = getGame(id)
    if (!definition) return <p role="alert">This game is not available.</p>
    return (
      <GameShell key={`${id}-${options.replay?.seed ?? 'new'}`} definition={definition} level={progress.state.games[id]?.level ?? 1} userId={userId} sessionNo={sessionNo.current}
        reduceMotion={settings.reduceMotion} sound={settings.sound} market={market} replay={options.replay} stepLabel={options.stepLabel} onSkip={options.onSkip}
        onDone={done => { finished(id, done, { warmupStep: options.warmupStep, replay: options.replay !== undefined }); options.onFinished?.() }}
        onExit={options.onExit} />
    )
  }

  return (
    <div className="games-root" style={{ fontSize: `${settings.zoom}%` }} data-reduce-motion={settings.reduceMotion || undefined} data-palette={settings.palette}>
      <header className="games-head">
        <h2>Games</h2>
        <nav aria-label="Games sections" className="games-tabs">
          {(Object.keys(TAB_LABEL) as Tab[]).map(key => (
            <button key={key} className={key === tab ? 'is-active' : ''} aria-current={key === tab ? 'page' : undefined} onClick={() => { setPlaying(null); setTab(key) }}>{TAB_LABEL[key]}</button>
          ))}
        </nav>
        {onClose && <button onClick={onClose} aria-label="Close Games">Close</button>}
      </header>
      {sessionKind === 'real' && <p className="games-banner" role="status">A real trading session is active. Keep your trading window in view; Games never touches it.</p>}
      {progress.status === 'loading' && <p role="status">Loading your progress…</p>}
      {progress.status === 'offline' && <p className="games-banner" role="status">Offline or the server is not reachable. Sessions are saved on this device and sent when you reconnect.</p>}
      {progress.status === 'unavailable' && <p className="games-banner" role="alert">This server does not support Games yet. Update the backend to use them.</p>}
      {progress.pending > 0 && <p className="games-banner" role="status">{progress.pending} session(s) waiting to be saved.</p>}
      {progress.notice && <p className="games-banner" role="alert">{progress.notice} <button onClick={progress.dismissNotice}>Dismiss</button></p>}

      <main>
        {playing ? renderGame(playing, { onExit: () => setPlaying(null) }) : (
          <>
            {(tab === 'brain' || tab === 'market') && <GameList pool={tab} levels={progress.state.games} onPlay={setPlaying} />}
            {tab === 'dashboard' && <Dashboard state={progress.state} sessions={sessionLog.sessions} today={today} />}
            {tab === 'warmup' && <Warmup state={progress.state} settings={settings} userId={userId} today={today} renderGame={renderGame} />}
            {tab === 'review' && <ReviewTab sessions={sessionLog.sessions} renderReplay={(session, onExit) => renderGame(session.gameId, { onExit, replay: { seed: session.seed, level: session.level } })} />}
            {tab === 'settings' && <SettingsPanel settings={settings} disabled={progress.status !== 'ready'} onSave={progress.saveSettings} />}
          </>
        )}
      </main>
      <footer className="games-foot">Practice tools: ratings show your progress on these tasks, nothing more.</footer>
    </div>
  )
}

function GameList({ pool, levels, onPlay }: { pool: Pool; levels: Partial<Record<GameId, { level?: number; sessions?: number }>>; onPlay: (id: GameId) => void }) {
  const entries = gamesIn(pool)
  return (
    <div className="games-grid">
      {CATEGORIES.filter(category => entries.some(entry => entry.category === category)).map(category => (
        <section key={category} className="games-category">
          <h3>{CATEGORY_LABEL[category]}</h3>
          {entries.filter(entry => entry.category === category).map(entry => {
            const record = levels[entry.id]
            const playable = isPlayable(entry.id)
            return (
              <article key={entry.id} className="games-card" data-playable={playable}>
                <h4>{entry.title}</h4>
                <p>{entry.blurb}</p>
                <p className="games-meta">{record?.sessions ? `Level ${record.level ?? 1} · ${levelBand(record.level ?? 1)} · ${record.sessions} sessions` : 'Not played yet'}</p>
                <button disabled={!playable} onClick={() => onPlay(entry.id)}>{playable ? 'Play' : 'Coming soon'}</button>
              </article>
            )
          })}
        </section>
      ))}
    </div>
  )
}

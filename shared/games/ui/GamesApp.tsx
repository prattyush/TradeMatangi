import { useCallback, useMemo, useRef, useState } from 'react'
import { ALL_GAME_IDS, CATEGORY_LABEL, CATEGORIES, gamesIn, type GameId, type Pool } from '../core/ids'
import type { GamesRequest } from '../core/client'
import { categoryRatings } from '../core/scoring'
import { getGame, isPlayable } from '../core/registry'
import { levelBand } from '../core/difficulty'
import { normalizeSettings, type GamesSettings } from '../core/settings'
import { newId, localDate } from '../core/uid'
import type { SessionResult } from '../core/progress'
import { GameShell, type ShellDone } from './GameShell'
import { useProgress } from './useProgress'
import '../games'
import './games.css'

export type SessionKind = 'none' | 'sim' | 'paper' | 'real'
type Tab = 'brain' | 'market' | 'dashboard' | 'warmup' | 'settings'

export interface GamesAppProps {
  /** Transport to `/api/desktop/v1/games/*` (Rust command on the desktop, `fetch` on the website). */
  request: GamesRequest
  /** Whether a trading session is running next to this window (shows a banner only; Games never touches it). */
  sessionKind?: SessionKind
  /** Passed by hosts that embed Games as an overlay. */
  onClose?: () => void
}

const TAB_LABEL: Record<Tab, string> = { brain: 'Brain', market: 'Market', dashboard: 'Dashboard', warmup: 'Warm-up', settings: 'Settings' }

export default function GamesApp({ request, sessionKind = 'none', onClose }: GamesAppProps) {
  const progress = useProgress(request)
  const [tab, setTab] = useState<Tab>('brain')
  const [playing, setPlaying] = useState<GameId | null>(null)
  const sessionNo = useRef(1)
  const settings = progress.settings
  const userId = progress.state.user_id ?? 'unknown'

  const ratings = useMemo(() => categoryRatings(ALL_GAME_IDS.map(id => ({ id, emaScore: progress.state.games[id]?.emaScore }))), [progress.state.games])

  const onDone = useCallback((id: GameId) => (done: ShellDone) => {
    const result: SessionResult = { id: newId(), gameId: id, mode: done.mode, level: done.level, date: localDate(), minutes: done.minutes, summary: done.summary, playedAt: new Date().toISOString() }
    sessionNo.current += 1
    void progress.record(result)
  }, [progress])

  const definition = playing ? getGame(playing) : undefined
  return (
    <div className="games-root" style={{ fontSize: `${settings.zoom}%` }} data-reduce-motion={settings.reduceMotion || undefined}>
      <header className="games-head">
        <h2>Games</h2>
        <nav aria-label="Games sections" className="games-tabs">
          {(Object.keys(TAB_LABEL) as Tab[]).map(key => (
            <button key={key} className={key === tab ? 'is-active' : ''} onClick={() => { setPlaying(null); setTab(key) }}>{TAB_LABEL[key]}</button>
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

      {playing && definition ? (
        <GameShell key={playing} definition={definition} level={progress.state.games[playing]?.level ?? 1} userId={userId} sessionNo={sessionNo.current}
          onDone={onDone(playing)} onExit={() => setPlaying(null)} />
      ) : (
        <main>
          {(tab === 'brain' || tab === 'market') && <GameList pool={tab} levels={progress.state.games} onPlay={setPlaying} />}
          {tab === 'dashboard' && <Dashboard ratings={ratings} played={ALL_GAME_IDS.filter(id => (progress.state.games[id]?.sessions ?? 0) > 0).length} />}
          {tab === 'warmup' && <section><h3>Daily Warm-up</h3><p>A short daily routine that picks games from your weakest categories. It arrives once the games it draws on are in. Pool setting: <strong>{settings.warmupPool}</strong>.</p></section>}
          {tab === 'settings' && <SettingsPanel settings={settings} disabled={progress.status !== 'ready'} onSave={progress.saveSettings} />}
        </main>
      )}
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

function Dashboard({ ratings, played }: { ratings: ReturnType<typeof categoryRatings>; played: number }) {
  return (
    <section>
      <h3>Dashboard</h3>
      {played === 0 && <p>Play a game in Progress mode and your category ratings appear here.</p>}
      <ul className="games-ratings">
        {CATEGORIES.map(category => (
          <li key={category}><span>{CATEGORY_LABEL[category]}</span><meter min={0} max={100} value={ratings[category] ?? 0} /><span>{ratings[category] === undefined ? '–' : ratings[category]}</span></li>
        ))}
      </ul>
    </section>
  )
}

function SettingsPanel({ settings, disabled, onSave }: { settings: GamesSettings; disabled: boolean; onSave: (next: GamesSettings) => Promise<void> }) {
  const [draft, setDraft] = useState<GamesSettings>(settings)
  const [message, setMessage] = useState('')
  const set = <K extends keyof GamesSettings>(key: K, value: GamesSettings[K]) => setDraft(current => normalizeSettings({ ...current, [key]: value }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  return (
    <section>
      <h3>Settings</h3>
      <label><input type="checkbox" checked={draft.sound} onChange={event => set('sound', event.target.checked)} /> Sound (off by default)</label>
      <label><input type="checkbox" checked={draft.reduceMotion} onChange={event => set('reduceMotion', event.target.checked)} /> Reduce motion</label>
      <label><input type="checkbox" checked={draft.lowMemory} onChange={event => set('lowMemory', event.target.checked)} /> Low memory mode</label>
      <label>Size <input type="range" min={80} max={150} step={5} value={draft.zoom} onChange={event => set('zoom', Number(event.target.value))} /> {draft.zoom}%</label>
      <label>Warm-up games <select value={draft.warmupPool} onChange={event => set('warmupPool', event.target.value as GamesSettings['warmupPool'])}><option value="both">Brain and market</option><option value="market">Market only</option><option value="brain">Brain only</option></select></label>
      <div className="games-row">
        <button disabled={disabled || !dirty} onClick={() => { setMessage('Saving…'); onSave(draft).then(() => setMessage('Saved.'), error => setMessage(`Could not save: ${String(error instanceof Error ? error.message : error)}`)) }}>Save settings</button>
        <span role="status">{message}</span>
      </div>
      <p className="games-meta">Games are practice tools. They do not claim to improve intelligence, health or trading results.</p>
    </section>
  )
}

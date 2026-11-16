import { useMemo, useState } from 'react'
import { ALL_GAME_IDS, CATEGORIES, CATEGORY_LABEL, type GameId } from '../core/ids'
import { categoryRatings } from '../core/scoring'
import { levelBand } from '../core/difficulty'
import { isPlayable } from '../core/registry'
import { gameRows, TREND_PANELS, trendDirection, trendSeries, warmupCount, warmupStreak, WARMUP_STEPS, type LocalSession, type PoolFilter } from '../core/dashboard'
import type { ProgressState } from '../core/progress'
import { Sparkline } from './Sparkline'

const FILTERS: Array<{ id: PoolFilter; label: string }> = [{ id: 'all', label: 'All' }, { id: 'brain', label: 'Brain' }, { id: 'market', label: 'Market' }]
const DIRECTION_TEXT = { better: 'improving', worse: 'getting worse', steady: 'steady', unknown: 'not enough sessions yet' } as const

export function Dashboard({ state, sessions, today }: { state: ProgressState; sessions: LocalSession[]; today: string }) {
  const [filter, setFilter] = useState<PoolFilter>('all')
  // The rating of a category averages every game in it, from both pools (spec 17.8), whatever the filter shows below.
  const ratings = useMemo(() => categoryRatings(ALL_GAME_IDS.map(id => ({ id, emaScore: state.games[id]?.emaScore }))), [state.games])
  // Games you can play come first; the market games that have not shipped yet follow.
  const rows = useMemo(() => gameRows(state, filter).sort((a, b) => Number(isPlayable(b.id)) - Number(isPlayable(a.id))), [state, filter])
  const streak = useMemo(() => warmupStreak(state.days, today), [state.days, today])
  const played = rows.filter(row => row.sessions > 0).length
  const panels = filter === 'market' ? [] : TREND_PANELS

  return (
    <section aria-labelledby="games-dash-title">
      <h3 id="games-dash-title">Dashboard</h3>
      <div className="games-row" role="group" aria-label="Show games from">
        {FILTERS.map(option => (
          <button key={option.id} className={option.id === filter ? 'is-active' : ''} aria-pressed={option.id === filter} onClick={() => setFilter(option.id)}>{option.label}</button>
        ))}
      </div>

      <p className="games-streak" role="status">
        Warm-up streak: <strong>{streak.current} day{streak.current === 1 ? '' : 's'}</strong> · best {streak.best}
        {' · '}{streak.doneToday ? 'today is done' : `today: ${warmupCount(state.days[today])} of ${WARMUP_STEPS} steps`}
      </p>

      <h4>Category ratings <span className="games-meta">(all games in each category)</span></h4>
      {Object.keys(ratings).length === 0 && <p>Play a game in Progress mode and your category ratings appear here.</p>}
      <ul className="games-ratings">
        {CATEGORIES.map(category => (
          <li key={category}>
            <span id={`rate-${category}`}>{CATEGORY_LABEL[category]}</span>
            <meter min={0} max={100} value={ratings[category] ?? 0} aria-labelledby={`rate-${category}`} />
            <span>{ratings[category] === undefined ? '–' : ratings[category]}</span>
          </li>
        ))}
      </ul>

      <h4>Games</h4>
      {played === 0 && <p className="games-meta">No sessions in this view yet.</p>}
      <table className="games-table">
        <caption className="games-sr">Level, best score and recent scores per game</caption>
        <thead><tr><th scope="col">Game</th><th scope="col">Level</th><th scope="col">Sessions</th><th scope="col">Best</th><th scope="col">Rating</th><th scope="col">Last scores</th></tr></thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} data-playable={isPlayable(row.id)}>
              <th scope="row">{row.title}<span className="games-meta"> · {CATEGORY_LABEL[row.category]}{row.pool === 'brain' ? '' : ' · market'}</span></th>
              <td>{row.sessions ? <span className="games-badge">L{row.level} {levelBand(row.level)}</span> : '–'}</td>
              <td>{row.sessions || '–'}</td>
              <td>{row.best ?? '–'}</td>
              <td>{row.rating === undefined ? '–' : Math.round(row.rating)}</td>
              <td>{row.sessions ? <Sparkline values={row.scores} min={0} max={100} label={`${row.title}: last ${row.scores.length} scores, latest ${row.scores[row.scores.length - 1] ?? 'none'}`} /> : (isPlayable(row.id) ? '–' : 'coming soon')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="games-meta">The server keeps your last 20 scores of each game.</p>

      {panels.length > 0 && (
        <>
          <h4>Brain trends <span className="games-meta">(this device, Progress sessions)</span></h4>
          <div className="games-trends">
            {panels.map(panel => {
              const values = trendSeries(sessions, panel.gameId, panel.key)
              const server = state.games[panel.gameId as GameId]?.stats?.[panel.key]
              const latest = values.length ? values[values.length - 1] : server
              const direction = trendDirection(values, panel.better)
              return (
                <article key={panel.id} className="games-trend">
                  <h5>{panel.title}</h5>
                  <p className="games-trend-value">{latest === undefined ? '–' : `${latest} ${panel.unit}`}</p>
                  <Sparkline values={values} label={values.length ? `${panel.title}: ${values.length} sessions, ${DIRECTION_TEXT[direction]}` : panel.title} />
                  <p className="games-meta">{panel.better === 'lower' ? 'Lower is better' : 'Higher is better'} · {DIRECTION_TEXT[direction]}</p>
                  <p className="games-meta">{panel.note}</p>
                </article>
              )
            })}
          </div>
          <p className="games-meta">Reaction times depend on the screen, the keyboard and the browser, so compare them only on the same device.</p>
        </>
      )}
    </section>
  )
}

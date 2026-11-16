import { useState, type ReactNode } from 'react'
import { catalogueEntry, type GameId } from '../core/ids'
import { isPlayable } from '../core/registry'
import type { LocalSession } from '../core/dashboard'

interface Props {
  sessions: LocalSession[]
  renderReplay: (session: LocalSession, onExit: () => void) => ReactNode
}

const pad = (n: number) => String(n).padStart(2, '0')
const when = (stamp: string) => {
  const date = new Date(stamp)
  return Number.isNaN(date.getTime()) ? stamp.slice(0, 16) : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Review (spec 7.3, 17.8): the last sessions kept on this device, trial by trial, and a replay of the same puzzles. Never sent to the server. */
export function ReviewTab({ sessions, renderReplay }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [replaying, setReplaying] = useState<LocalSession | null>(null)
  const list = [...sessions].filter(entry => entry.review?.length).sort((a, b) => b.playedAt.localeCompare(a.playedAt))
  if (replaying) return <>{renderReplay(replaying, () => setReplaying(null))}</>
  const selected = list.find(entry => entry.id === openId)
  return (
    <section aria-labelledby="games-review-title">
      <h3 id="games-review-title">Review</h3>
      <p>Your recent sessions (the last 20) with every trial: what was shown, what you answered, the right answer and your time. They stay on this device and are not sent anywhere.</p>
      {list.length === 0 && <p>Play a game and its trials appear here.</p>}
      <div className="games-review-layout">
        <ul className="games-review-list" aria-label="Recent sessions">
          {list.map(entry => (
            <li key={entry.id}>
              <button aria-pressed={entry.id === openId} className={entry.id === openId ? 'is-active' : ''} onClick={() => setOpenId(entry.id)}>
                <strong>{catalogueEntry(entry.gameId as GameId).title}</strong> · score {entry.score} · level {entry.level}{entry.mode === 'practice' ? ' · practice' : ''}
                <span className="games-meta"> {when(entry.playedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
        {selected && (
          <div className="games-review-detail">
            <h4>{catalogueEntry(selected.gameId as GameId).title} · score {selected.score}</h4>
            {selected.stats && <p className="games-meta">{Object.entries(selected.stats).slice(0, 12).map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`).join(' · ')}</p>}
            <div className="games-row">
              <button disabled={!isPlayable(selected.gameId as GameId)} onClick={() => setReplaying(selected)}>Play these puzzles again</button>
            </div>
            <p className="games-meta">A replay starts from the same seed. Games that adapt to your answers (the span games) start the same but can go a different way.</p>
            <div className="games-review games-review-table">
              <table>
                <caption className="games-sr">Trials of the selected session</caption>
                <thead><tr><th scope="col">#</th><th scope="col">Shown</th><th scope="col">You answered</th><th scope="col">Correct answer</th><th scope="col">Time</th></tr></thead>
                <tbody>
                  {selected.review!.map(row => (
                    <tr key={row.n} data-correct={row.correct}>
                      <td>{row.n}</td><td>{row.shown}</td><td>{row.answered}</td><td>{row.correctAnswer}</td>
                      <td>{row.rtMs === null ? '—' : `${Math.round(row.rtMs)} ms`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

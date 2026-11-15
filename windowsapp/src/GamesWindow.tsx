import { lazy, Suspense, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { gamesRequest } from './gamesApi'

const GamesApp = lazy(() => import('../../shared/games/ui/GamesApp'))

/** Root of the separate Games window (`index.html?window=games`). It shares no React tree or state with trading. */
export default function GamesWindow() {
  const request = useMemo(() => {
    const baseUrl = localStorage.getItem('desktop-server-url') ?? 'http://localhost:8700'
    return gamesRequest(baseUrl, (command, args) => invoke(command, args))
  }, [])
  return <Suspense fallback={<p role="status">Loading Games…</p>}><GamesApp request={request} /></Suspense>
}

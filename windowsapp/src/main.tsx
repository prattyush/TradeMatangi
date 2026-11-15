import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { WindowErrorBoundary } from './WindowErrorBoundary'
import './styles.css'

// The Games window is its own WebView (`?window=games`); it loads separately and never mounts the trading App.
const GamesWindow = lazy(() => import('./GamesWindow'))
const isGames = new URLSearchParams(window.location.search).get('window') === 'games'
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><WindowErrorBoundary>{isGames ? <Suspense fallback={null}><GamesWindow /></Suspense> : <App />}</WindowErrorBoundary></React.StrictMode>,
)

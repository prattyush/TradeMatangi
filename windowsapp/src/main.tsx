import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { WindowErrorBoundary } from './WindowErrorBoundary'
import './styles.css'
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><WindowErrorBoundary><App /></WindowErrorBoundary></React.StrictMode>)

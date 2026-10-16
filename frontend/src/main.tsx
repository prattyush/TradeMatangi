import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { WebsiteChartTools } from './components/WebsiteChartTools'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebsiteChartTools><App /></WebsiteChartTools>
  </StrictMode>,
)

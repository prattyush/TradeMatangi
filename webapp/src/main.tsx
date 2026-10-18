import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import WebsiteApp from '../../frontend/src/WebsiteApp'
import { ChartMenuGesture } from '../../shared/charts/ChartMenuGesture'
import '../../frontend/src/index.css'
import { AppShell } from './AppShell'
import './style.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChartMenuGesture.Provider value="doubleclick">
      <AppShell><WebsiteApp /></AppShell>
    </ChartMenuGesture.Provider>
  </StrictMode>,
)

// Development never installs a worker. Registration failure does not block the app.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL, updateViaCache: 'none',
    }).catch(error => console.warn('Offline page unavailable', error))
  }, { once: true })
}

import { InstallAppProvider } from './InstallApp'
import { registerWebappWorker } from './registerWorker'
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
      <InstallAppProvider><AppShell><WebsiteApp /></AppShell></InstallAppProvider>
    </ChartMenuGesture.Provider>
  </StrictMode>,
)

// Development never installs a worker.
if (import.meta.env.PROD) registerWebappWorker()

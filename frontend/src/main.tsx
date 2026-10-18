import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import WebsiteApp from './WebsiteApp'
import { InstallAppProvider } from '../../webapp/src/InstallApp'
import { registerWebappWorker } from '../../webapp/src/registerWorker'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <InstallAppProvider><WebsiteApp showInstall /></InstallAppProvider>
  </StrictMode>,
)

if (import.meta.env.PROD) registerWebappWorker()

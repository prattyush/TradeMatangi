import './theme.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AppProviders } from './app/AppContext'
import { NavProvider } from './app/Nav'
import { createServices } from './app/services'
import { ToastProvider } from './shell/Toast'

const services = createServices()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <AppProviders services={services}>
        <NavProvider>
          <App />
        </NavProvider>
      </AppProviders>
    </ToastProvider>
  </StrictMode>,
)

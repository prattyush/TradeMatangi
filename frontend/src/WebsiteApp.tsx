import App from './App'
import { WebsiteChartTools } from './components/WebsiteChartTools'

/** Shared application composition for the website and installable web app. */
export default function WebsiteApp({ showInstall = false }: { showInstall?: boolean }) {
  return <WebsiteChartTools><App showInstall={showInstall} /></WebsiteChartTools>
}

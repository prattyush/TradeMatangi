import { useAuth } from './app/AppContext'
import { useNav } from './app/Nav'
import { Shell } from './shell/Shell'
import { Spinner } from './shell/States'
import { Login } from './screens/Login'
import { More } from './screens/More'
import { SessionsScreen } from './screens/sessions/SessionsScreen'
import { StatsScreen } from './screens/stats/StatsScreen'
import { BrowseScreen } from './screens/browse/BrowseScreen'
import { VideosScreen } from './screens/videos/VideosScreen'
import { PhoneAnalysisProvider } from './env/analysisEnvironment'

function Screens() {
  const { tab } = useNav()
  return (
    <PhoneAnalysisProvider>
      <Shell>
        {tab === 'more' ? <More /> : tab === 'sessions' ? <SessionsScreen /> : tab === 'stats' ? <StatsScreen /> : tab === 'videos' ? <VideosScreen /> : <BrowseScreen />}
      </Shell>
    </PhoneAnalysisProvider>
  )
}

export function App() {
  const { status } = useAuth()
  if (status === 'loading') return <div className="splash"><Spinner label="Starting" /></div>
  if (status === 'signedOut') return <Login />
  return <Screens />
}

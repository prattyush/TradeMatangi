import { useAuth } from './app/AppContext'
import { useNav, type Tab } from './app/Nav'
import { Shell } from './shell/Shell'
import { Spinner } from './shell/States'
import { Login } from './screens/Login'
import { More } from './screens/More'
import { Placeholder } from './screens/Placeholder'

const TITLES: Record<Exclude<Tab, 'more'>, string> = {
  sessions: 'Sessions', stats: 'Stats', browse: 'Browse', positions: 'Positions', videos: 'Videos',
}

function Screens() {
  const { tab } = useNav()
  return <Shell>{tab === 'more' ? <More /> : <Placeholder title={TITLES[tab]} />}</Shell>
}

export function App() {
  const { status } = useAuth()
  if (status === 'loading') return <div className="splash"><Spinner label="Starting" /></div>
  if (status === 'signedOut') return <Login />
  return <Screens />
}

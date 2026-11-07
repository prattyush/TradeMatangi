import { createContext, useContext, type ReactNode } from 'react'

/** App-only controls can occupy existing headers without adding a window bar. */
export const AppWindowControlsContext = createContext<ReactNode>(null)
export function AppWindowControls() {
  return <>{useContext(AppWindowControlsContext)}</>
}

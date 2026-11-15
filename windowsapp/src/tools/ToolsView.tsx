import { useState, type ReactNode } from 'react'
import VideoMaker from './VideoMaker'
import './videoTools.css'

interface ToolsViewProps {
  viewSelector: ReactNode
  baseUrl: string
  token: string
  onUnauthorized: () => void
  active: boolean
}

const TOOLS = [{ id: 'video', label: 'Trading Video Maker' }] as const
type ToolId = (typeof TOOLS)[number]['id']

/** Desktop "Tools" view: a list of tools on the left, the chosen tool on the right. */
export default function ToolsView({ viewSelector, baseUrl, token, onUnauthorized, active }: ToolsViewProps) {
  const [tool, setTool] = useState<ToolId>('video')
  return <div className="tools-view" hidden={!active}>
    <nav className="tools-nav" aria-label="Tools">{viewSelector}<span className="tools-title">Tools</span></nav>
    <div className="tools-body">
      <aside className="tools-list" aria-label="Available tools">
        <h3>Tools</h3>
        {TOOLS.map(item => <button key={item.id} aria-pressed={tool === item.id} onClick={() => setTool(item.id)}>{item.label}</button>)}
      </aside>
      <section className="tools-content">
        {tool === 'video' && <VideoMaker baseUrl={baseUrl} token={token} onUnauthorized={onUnauthorized} />}
      </section>
    </div>
  </div>
}

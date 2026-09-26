import { Component, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'

export class WindowErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(error: unknown) { return { error: String(error) } }
  componentDidCatch(error: unknown) {
    if ('__TAURI_INTERNALS__' in window) void invoke('record_desktop_renderer_diagnostic', { kind: 'window_render_failed', payload: { error: String(error), screen: new URLSearchParams(window.location.search).get('screen_id') } }).catch(() => {})
  }
  render() {
    if (!this.state.error) return this.props.children
    return <main role="alert"><h2>Unable to display this window</h2><p>{this.state.error}</p><p>Your backend trading sessions remain running.</p><button onClick={() => window.location.reload()}>Reload window</button>{'__TAURI_INTERNALS__' in window && <><button onClick={() => void invoke('focus_main_window')}>Main window</button><button onClick={() => void invoke('finish_window_close')}>Close window</button></>}</main>
  }
}

import BehaviorQuestionsManager from './BehaviorQuestionsManager'
import type { BehaviorApi } from './types'
import '../labeling/labeling.css'

interface Props { api: BehaviorApi; onClose: () => void; onChanged?: () => void; /** Above the host's own modals (default 2400). */ zIndex?: number }

/** The question manager in a modal, for opening it from the labeling screens. Escape or a backdrop click closes it. */
export default function BehaviorManagerModal({ api, onClose, onChanged, zIndex }: Props) {
  return (
    <div className="tl-modal tl-root" role="dialog" aria-modal="true" aria-label="Behavior questions" style={zIndex ? { zIndex } : undefined}
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <div className="tl-modal-card">
        <header><h3>Behavior questions</h3><button type="button" className="tl-ghost" onClick={onClose}>Close</button></header>
        <BehaviorQuestionsManager api={api} onChanged={onChanged} />
      </div>
    </div>
  )
}

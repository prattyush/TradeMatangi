import SummaryView from './SummaryView'

/** The Summary over the whole window (website and webapp); the Windows app shows `SummaryView` in its own Summary view instead. */
export default function SummaryModal({ onClose, ...defaults }: { onClose: () => void; defaultSymbol?: string; defaultStartDate?: string; defaultEndDate?: string; defaultInstrumentType?: string; defaultSessionType?: string }) {
  return <div className="sm-overlay" role="dialog" aria-modal="true" aria-label="Summary">
    <header className="sm-overlay-head">
      <div><span className="sm-eyebrow">TRADE MATANGI / ANALYSIS</span><h1>Summary</h1></div>
      <button type="button" className="sm-close" aria-label="Close summary" onClick={onClose}>×</button>
    </header>
    <div className="sm-overlay-body"><SummaryView {...defaults} /></div>
  </div>
}

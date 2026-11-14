import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionGroup } from '../../../../../shared/analysis/TradeAnalysis'
import type { AnalysisTrade } from '../../../../../shared/analysis/api'
import TradeLabeling from '../../../../../shared/analysis/TradeLabeling'
import { AnalysisProvider, useAnalysisEnvironment } from '../../../../../shared/analysis/environment'
import { useBackHandler } from '../../../app/Nav'
import { useToast } from '../../../shell/Toast'
import { LabelingHostContext } from './context'
import PhoneLabelCharts from './PhoneLabelCharts'
import './labeling.css'

const GIVE_UP_MS = 6000

/**
 * Label trades, full screen: the chart (centred on the viewed trade) on the left, the shared one-trade-at-a-time form
 * on the right. The shared screen does the loading, autosave, behavior marks and save status; this only lays it out,
 * supplies the phone chart, and makes leaving wait for pending saves so a label is never lost by pressing Back.
 */
export function LabelingOverlay({ group, trades, readOnly, onClose }: { group: SessionGroup; trades: AnalysisTrade[]; readOnly: boolean; onClose: () => void }) {
  const environment = useAnalysisEnvironment()
  const toast = useToast()
  const unsaved = useRef(false)
  const saving = useRef(false)
  const [closing, setClosing] = useState(false)

  const requestClose = useCallback(() => {
    if (!unsaved.current && !saving.current) { onClose(); return }
    toast('Saving labels…')
    setClosing(true)
  }, [onClose, toast])
  useBackHandler(() => { requestClose(); return true })

  // Wait for pending saves; if they never finish (offline, server error) ask before throwing the changes away.
  useEffect(() => {
    if (!closing) return
    const poll = setInterval(() => { if (!unsaved.current && !saving.current) { clearInterval(poll); onClose() } }, 150)
    const giveUp = setTimeout(() => {
      clearInterval(poll)
      setClosing(false)
      if (window.confirm('Some labels could not be saved. Leave without saving them?')) onClose()
    }, GIVE_UP_MS)
    return () => { clearInterval(poll); clearTimeout(giveUp) }
  }, [closing, onClose])

  const labelEnvironment = useMemo(() => ({
    ...environment,
    labelView: 'one_by_one' as const,
    charts: { ...environment.charts, LabelCharts: PhoneLabelCharts },
    onDirtyChange: (value: boolean) => { unsaved.current = value },
    onLabelSavingChange: (value: boolean) => { saving.current = value },
  }), [environment])

  return (
    <div className="phone-labeling" role="dialog" aria-label="Label trades">
      <LabelingHostContext.Provider value={{ requestClose }}>
        <AnalysisProvider value={labelEnvironment}>
          <TradeLabeling readOnly={readOnly} symbol={group.symbol} date={group.date} sessionIds={group.sessions.map(session => session.session_id)}
            allTrades={trades} historicalDays={environment.historicalDays ?? 2} />
        </AnalysisProvider>
      </LabelingHostContext.Provider>
    </div>
  )
}

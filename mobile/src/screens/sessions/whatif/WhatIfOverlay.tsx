import { useCallback, useMemo, useRef } from 'react'
import type { SessionGroup } from '../../../../../shared/analysis/TradeAnalysis'
import type { AnalysisTrade } from '../../../../../shared/analysis/api'
import { AnalysisProvider, useAnalysisEnvironment } from '../../../../../shared/analysis/environment'
import type { PerformanceCycle } from '../../../../../shared/analysis/performance'
import TradeWhatIf from '../../../../../shared/analysis/whatif/TradeWhatIf'
import { useBackHandler } from '../../../app/Nav'
import { LabelingHostContext } from '../labeling/context'
import PhoneLabelCharts from '../labeling/PhoneLabelCharts'
import '../labeling/labeling.css'
import './whatif.css'

/**
 * What If, full screen: the chart (centred on the viewed trade, with the edited legs drawn as rings) on the left; on the right the
 * day and the trade, actual against what-if, and the trade's fills with price and quantity to change (the price also by tapping
 * the chart). The saved what-ifs bar is one line that opens. Read-only for trading: it only reads the day and saves its own
 * scenarios. Back cancels a price pick first, then asks before dropping unsaved changes, then closes.
 */
export function WhatIfOverlay({ group, trades, cycles, onClose }: { group: SessionGroup; trades: AnalysisTrade[]; cycles: PerformanceCycle[]; onClose: () => void }) {
  const environment = useAnalysisEnvironment()
  const dirty = useRef(false)
  const picking = useRef(false)
  const whatIfEnvironment = useMemo(() => ({
    ...environment, charts: { ...environment.charts, LabelCharts: PhoneLabelCharts },
    onDirtyChange: (value: boolean) => { dirty.current = value },
  }), [environment])
  const close = useCallback(() => {
    if (dirty.current && !window.confirm('Discard the unsaved what-if changes?')) return
    onClose()
  }, [onClose])
  useBackHandler(() => {
    if (picking.current) {
      // The chart owns the pick; an Escape press (not a trusted key, so the app's back probe ignores it) cancels it.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    }
    close()
    return true
  })
  const capitals = useMemo(() => new Map(group.sessions.map(session => [session.session_id, session.session_capital])), [group.sessions])
  const sessionTypes = useMemo(() => new Map(group.sessions.map(session => [session.session_id, session.session_type])), [group.sessions])
  const onPickingChange = useCallback((value: boolean) => { picking.current = value }, [])
  return (
    <div className="phone-labeling phone-whatif" role="dialog" aria-label="What if">
      <LabelingHostContext.Provider value={{ requestClose: close }}>
        <AnalysisProvider value={whatIfEnvironment}>
          <TradeWhatIf symbol={group.symbol} date={group.date} sessionIds={group.sessions.map(session => session.session_id)} allTrades={trades}
            historicalDays={environment.historicalDays ?? 2} cycles={cycles} capitals={capitals} sessionTypes={sessionTypes}
            readOnly={group.sessions.some(session => session.shared)} compact onPickingChange={onPickingChange} />
        </AnalysisProvider>
      </LabelingHostContext.Provider>
    </div>
  )
}

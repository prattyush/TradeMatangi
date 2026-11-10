import { useEffect, useMemo, useState } from 'react'
import type { BehaviorKind, BehaviorQuestion } from '../api'
import BehaviorChecklist from './BehaviorChecklist'
import { diffAnswers, questionsToShow } from './model'
import '../labeling/labeling.css'

interface Props {
  kind: BehaviorKind
  questions: BehaviorQuestion[]
  /** Question ids this trade is already marked with. */
  initial: ReadonlySet<string>
  disabled?: boolean
  /** Receives the changed answers whenever the user toggles something (empty when nothing changed). */
  onAnswersChange: (answers: Record<string, boolean>) => void
  /** Opens the question manager; offered when there is nothing of this type to answer yet. */
  onManage?: () => void
}

const NOUN: Record<BehaviorKind, string> = { entry: 'entry', exit: 'exit' }

/**
 * Behavior checklist for one trade inside a labeling popup. Keeps its own toggle state and reports only the answers
 * that differ from what was saved, so the popup can send them after the label (`saveBehaviorMarks`).
 */
export default function BehaviorPicker({ kind, questions, initial, disabled = false, onAnswersChange, onManage }: Props) {
  const [marked, setMarked] = useState<ReadonlySet<string>>(initial)
  const shown = useMemo(() => questionsToShow(questions, kind, initial), [questions, kind, initial])
  const ids = useMemo(() => shown.map(question => question.question_id), [shown])
  useEffect(() => { onAnswersChange(diffAnswers(initial, marked, ids)) }, [initial, marked, ids]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string, showed: boolean) => setMarked(current => { const next = new Set(current); if (showed) next.add(id); else next.delete(id); return next })
  if (!shown.length) {
    return onManage ? (
      <div className="tl-root bq-empty-picker">
        <span>No {NOUN[kind]} behavior questions yet.</span>
        <button type="button" className="tl-ghost" onClick={onManage}>Add questions</button>
      </div>
    ) : null
  }
  return <div className="tl-root"><BehaviorChecklist kind={kind} questions={questions} marked={marked} disabled={disabled} onToggle={toggle} /></div>
}

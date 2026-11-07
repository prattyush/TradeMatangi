import type { BehaviorKind, BehaviorQuestion } from '../api'
import { questionsToShow } from './model'

interface Props {
  kind: BehaviorKind
  questions: BehaviorQuestion[]
  /** Question ids this trade is marked with. */
  marked: ReadonlySet<string>
  disabled?: boolean
  onToggle: (questionId: string, showed: boolean) => void
}

const TITLES: Record<BehaviorKind, string> = { entry: 'Entry behaviors', exit: 'Exit behaviors' }

/** Yes/no toggles for the behavior questions of one type. Renders nothing when there is nothing to answer. */
export default function BehaviorChecklist({ kind, questions, marked, disabled = false, onToggle }: Props) {
  const rows = questionsToShow(questions, kind, marked)
  if (!rows.length) return null
  return (
    <div className="bq-checklist" role="group" aria-label={TITLES[kind]}>
      <span className="tl-label">{TITLES[kind]} <small>— did this trade show it?</small></span>
      {rows.map(question => {
        const on = marked.has(question.question_id)
        const archived = question.status === 'archived'
        return (
          <button key={question.question_id} type="button" role="switch" aria-checked={on}
            className={`bq-toggle ${on ? 'on' : ''} ${archived ? 'archived' : ''}`}
            // An archived question's old mark can be cleared but never set again.
            disabled={disabled || (archived && !on)} onClick={() => onToggle(question.question_id, !on)}>
            <span className="bq-switch" aria-hidden="true" />
            <span className="bq-text">{question.text}{archived && <em> · archived</em>}</span>
            <span className="bq-state">{on ? 'Yes' : 'No'}</span>
          </button>
        )
      })}
    </div>
  )
}

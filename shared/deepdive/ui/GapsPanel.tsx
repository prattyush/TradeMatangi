import { formatDay, gaps, sideLabel } from '../model'
import type { DeepDiveTag, DiveSetup } from '../types'

interface Props { setups: DiveSetup[]; tags: DeepDiveTag[]; onJump: (index: number) => void }

/** Every day that still has tags nobody has marked, with how many: a tag added late shows up on all earlier days. */
export default function GapsPanel({ setups, tags, onJump }: Props) {
  const list = gaps(setups, tags)
  if (!list.length) return <p className="pl-ok" role="status">Every tag is marked on every day.</p>
  return <div className="dd-gaps">
    <h4>Needs marking ({list.length} {list.length === 1 ? 'day' : 'days'})</h4>
    <ul>{list.map(gap => <li key={gap.id}>
      <button onClick={() => onJump(setups.findIndex(s => s.date === gap.date && s.symbol === gap.symbol && s.side === gap.side))}>
        {formatDay(gap.date)} · {sideLabel(gap.side)}
      </button>
      <span className="pl-muted">{gap.missing} {gap.missing === 1 ? 'tag' : 'tags'}</span>
    </li>)}</ul>
  </div>
}

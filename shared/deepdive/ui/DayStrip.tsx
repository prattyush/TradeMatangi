import { formatDay, setupId } from '../model'
import type { DiveSetup } from '../types'

interface Props { setups: DiveSetup[]; index: number; onSelect: (index: number) => void }

/** One chip per marked day, in walking order: green when every tag is marked, amber when some are not. */
export default function DayStrip({ setups, index, onSelect }: Props) {
  return <div className="dd-strip" role="tablist" aria-label="Marked days">
    {setups.map((setup, position) => <button key={setupId(setup)} role="tab" aria-selected={position === index}
      className={`dd-chip ${setup.complete ? 'complete' : 'incomplete'} ${setup.side}`} onClick={() => onSelect(position)}
      title={setup.complete ? 'All tags marked' : `${setup.missing.length} tag${setup.missing.length === 1 ? '' : 's'} not marked`}>
      {formatDay(setup.date).replace(/ \d{4}$/, '')} <b>{setup.side === 'buy' ? 'B' : 'S'}</b>
    </button>)}
  </div>
}

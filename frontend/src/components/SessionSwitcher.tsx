import { useState } from 'react'
import { SessionGroupResponse } from '../services/api'

interface Props {
  group: SessionGroupResponse
  selectedSessionId: string | null
  onSelect: (sessionId: string) => void
  onRename: (sessionId: string, alias: string | null) => Promise<void>
  onAdd: () => void
}

const modeColor: Record<string, string> = { paper: '#238636', real: '#da3633', sim: '#1f6feb', stepwise: '#9e6a03' }

export default function SessionSwitcher({ group, selectedSessionId, onSelect, onRename, onAdd }: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  return <div style={{ display: 'flex', gap: 5, alignItems: 'center', minWidth: 0, overflowX: 'auto' }}>
    {group.members.map(member => {
      const selected = member.session_id === selectedSessionId
      const label = `${member.symbol} · ${member.session_type === 'sim' ? 'Replay' : member.session_type === 'stepwise' ? 'Stepwise' : member.session_type === 'paper' ? 'Paper' : 'Real'}`
      return <div key={member.session_id} style={{ display: 'flex', alignItems: 'center', border: `1px solid ${selected ? modeColor[member.session_type] : '#30363d'}`, borderRadius: 5, background: selected ? '#21262d' : '#161b22', flexShrink: 0 }}>
        <button onClick={() => onSelect(member.session_id)} style={{ border: 0, background: 'transparent', color: selected ? '#fff' : '#c9d1d9', padding: '4px 7px', cursor: 'pointer', fontWeight: selected ? 700 : 500, fontSize: 11 }}>
          {member.session_alias ? `${member.session_alias} · ${label}` : label}
        </button>
        <button title="Rename session" onClick={() => setEditing(member.session_id)} style={{ border: 0, borderLeft: '1px solid #30363d', color: '#8b949e', background: 'transparent', padding: '4px 5px', cursor: 'pointer' }}>✎</button>
        {editing === member.session_id && <input autoFocus defaultValue={member.session_alias || ''} maxLength={40}
          onBlur={e => { setEditing(null); onRename(member.session_id, e.target.value.trim() || null).catch(() => {}) }}
          onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur() }}
          style={{ width: 92, background: '#0d1117', color: '#fff', border: '1px solid #58a6ff', borderRadius: 3, marginRight: 4 }} />}
      </div>
    })}
    {group.members.length < 4 && <button onClick={onAdd} style={{ color: '#58a6ff', background: '#161b22', border: '1px dashed #30363d', borderRadius: 5, padding: '4px 7px', cursor: 'pointer', flexShrink: 0, fontSize: 11 }}>+ Add Session</button>}
  </div>
}

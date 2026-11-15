import { useState } from 'react'
import type { FineDefinition, PatternsClient } from '../patternsClient'
import { parseSubTypes } from './fineStructuresModel'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Structure definitions: the named structures (and optional sub-types) that flows are built from. System ones are read only. */
export function FineDefinitions({ client, definitions, onRefresh }: { client: PatternsClient; definitions: FineDefinition[]; onRefresh: () => void }) {
  const [editing, setEditing] = useState<FineDefinition | 'new' | null>(null)
  const [name, setName] = useState('')
  const [subTypes, setSubTypes] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [error, setError] = useState('')

  const start = (target: FineDefinition | 'new') => {
    setEditing(target); setError('')
    setName(target === 'new' ? '' : target.name); setSubTypes(target === 'new' ? '' : target.sub_types.join(', '))
  }
  const save = async () => {
    if (!name.trim() || !editing) return
    const body = { name: name.trim(), sub_types: parseSubTypes(subTypes) }
    try {
      if (editing === 'new') await client.createDefinition(body); else await client.updateDefinition(editing.definition_id, body)
      setEditing(null); onRefresh()
    } catch (e) { setError(errorText(e)) }
  }
  const remove = async (id: string) => {
    try { await client.deleteDefinition(id); setConfirmDelete(null); onRefresh() } catch (e) { setError(errorText(e)) }
  }

  return <div className="fs-defs">
    <div className="pl-bar"><strong>Structure definitions</strong><button onClick={() => start('new')}>+ Add definition</button></div>
    {error && <p className="pl-error" role="alert">{error}</p>}
    {editing && <div className="pl-bar">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Structure name" aria-label="Structure name" />
      <input value={subTypes} onChange={e => setSubTypes(e.target.value)} placeholder="Sub-types (comma separated)" aria-label="Sub-types" size={36} />
      <button className="pl-save" onClick={() => void save()} disabled={!name.trim()}>Save</button>
      <button onClick={() => setEditing(null)}>Cancel</button>
    </div>}
    <table><tbody>{definitions.map(d => <tr key={d.definition_id}>
      <td><strong>{d.name}</strong></td>
      <td>{d.sub_types.length ? d.sub_types.map(t => <span key={t} className="fs-chip">{t}</span>) : <span className="pl-muted">no sub-types</span>}</td>
      <td className="pl-actions">{d.is_predefined && <span className="pl-muted">system</span>}
        {d.can_delete && <>
          <button onClick={() => start(d)}>Edit</button>
          {confirmDelete === d.definition_id
            ? <><button className="pl-danger" onClick={() => void remove(d.definition_id)}>Confirm delete</button><button onClick={() => setConfirmDelete(null)}>Cancel</button></>
            : <button onClick={() => setConfirmDelete(d.definition_id)}>Delete</button>}
        </>}</td>
    </tr>)}</tbody></table>
  </div>
}

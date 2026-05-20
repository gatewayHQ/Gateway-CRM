/**
 * Data Management — admin page for managing controlled vocabulary values.
 *
 * Mirrors the old CRM's "Option Value Settings" screen:
 *   - Field selector (Submarket / Asset Type / Tag / Industry / etc.)
 *   - Table of values with associated record count
 *   - Add / rename / delete / merge operations
 *
 * Renaming a value propagates to all referencing rows (via merge_option_values RPC).
 * Merging combines duplicates into a canonical value (e.g. "Cherokee Cherokee" → "Cherokee County").
 */

import React, { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, ConfirmDialog, Modal, pushToast } from '../components/UI.jsx'
import { useOptionValues } from '../hooks/useOptionValues.js'

const MANAGED_FIELDS = [
  { key: 'submarket',  label: 'Submarket'  },
  { key: 'asset_type', label: 'Asset Type' },
  { key: 'tag',        label: 'Tag'        },
  { key: 'industry',   label: 'Industry'   },
]

export default function DataManagementPage() {
  const [fieldKey, setFieldKey] = useState('submarket')
  const [counts, setCounts] = useState({})
  const [loadingCounts, setLoadingCounts] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [editing, setEditing] = useState(null)        // { value }
  const [editDraft, setEditDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [newValue, setNewValue] = useState('')
  const [merging, setMerging] = useState(null)        // { from: string[], to: '' }
  const [confirmDelete, setConfirmDelete] = useState(null)

  const { values, loading, add, rename, merge, remove, refetch } = useOptionValues(fieldKey)

  // Clear selection on field change
  useEffect(() => {
    setSelected(new Set())
    setEditing(null)
    setMerging(null)
  }, [fieldKey])

  // Load record counts from the view
  const loadCounts = async () => {
    setLoadingCounts(true)
    const { data, error } = await supabase
      .from('option_value_counts')
      .select('value, record_count')
      .eq('field_key', fieldKey)
    setLoadingCounts(false)
    if (error) {
      // View missing — fall back to zeros, don't surface error
      setCounts({})
      return
    }
    const map = {}
    for (const r of data || []) map[r.value] = Number(r.record_count)
    setCounts(map)
  }

  useEffect(() => { loadCounts() }, [fieldKey, values.length])

  const toggleSelect = (val) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(val) ? next.delete(val) : next.add(val)
      return next
    })
  }
  const toggleAll = () => {
    setSelected(prev => prev.size === values.length ? new Set() : new Set(values))
  }

  const handleAdd = async () => {
    const v = newValue.trim()
    if (!v) return
    const r = await add(v)
    if (r.ok) {
      if (r.alreadyExisted) pushToast(`"${v}" already exists`, 'info')
      else pushToast(`Added "${v}"`)
      setNewValue('')
      setAdding(false)
    } else {
      pushToast(r.error, 'error')
    }
  }

  const handleEditSave = async () => {
    const from = editing.value
    const to   = editDraft.trim()
    if (!to || from === to) { setEditing(null); return }
    const r = await rename(from, to)
    if (r.ok) {
      pushToast(`Renamed → "${to}" (${r.affected} record${r.affected !== 1 ? 's' : ''} updated)`)
      setEditing(null)
      loadCounts()
    } else {
      pushToast(r.error, 'error')
    }
  }

  const handleDelete = async (value) => {
    const r = await remove(value)
    if (r.ok) {
      pushToast(`Deleted "${value}"`)
      setConfirmDelete(null)
      loadCounts()
    } else {
      pushToast(r.error, 'error')
    }
  }

  const startMerge = () => {
    setMerging({ from: [...selected], to: [...selected][0] || '' })
  }
  const handleMergeConfirm = async () => {
    const fromValues = merging.from.filter(v => v !== merging.to)
    if (fromValues.length === 0) { setMerging(null); return }
    const r = await merge(fromValues, merging.to)
    if (r.ok) {
      pushToast(`Merged ${fromValues.length} value${fromValues.length !== 1 ? 's' : ''} into "${merging.to}" (${r.affected} record${r.affected !== 1 ? 's' : ''} updated)`)
      setMerging(null)
      setSelected(new Set())
      loadCounts()
    } else {
      pushToast(r.error, 'error')
    }
  }

  const fieldLabel = MANAGED_FIELDS.find(f => f.key === fieldKey)?.label || fieldKey

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Data Management</div>
          <div className="page-sub">Manage controlled vocabulary values across your workspace</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Header: field selector + actions */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '16px 20px',
          borderBottom: '1px solid var(--gw-border)',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label style={{ fontSize: 11, color: 'var(--gw-mist)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
              Field
            </label>
            <select
              className="form-control"
              value={fieldKey}
              onChange={(e) => setFieldKey(e.target.value)}
              style={{ minWidth: 220 }}
            >
              {MANAGED_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </div>

          <div style={{ flex: 1 }} />

          <button
            className="btn btn--secondary"
            disabled={selected.size < 2}
            onClick={startMerge}
            style={{ opacity: selected.size < 2 ? 0.5 : 1, cursor: selected.size < 2 ? 'not-allowed' : 'pointer' }}
          >
            <Icon name="link" size={13} /> Merge Values {selected.size >= 2 ? `(${selected.size})` : ''}
          </button>
          <button className="btn btn--primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} /> Add Value
          </button>
        </div>

        {/* Table */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '40px 1fr 200px 100px',
          padding: '10px 20px',
          background: 'var(--gw-bone)',
          borderBottom: '1px solid var(--gw-border)',
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--gw-mist)',
          alignItems: 'center',
        }}>
          <input
            type="checkbox"
            checked={values.length > 0 && selected.size === values.length}
            onChange={toggleAll}
            ref={el => el && (el.indeterminate = selected.size > 0 && selected.size < values.length)}
            style={{ cursor: 'pointer' }}
          />
          <div>Field Value</div>
          <div>Associated Record Count</div>
          <div style={{ textAlign: 'right' }}>Actions</div>
        </div>

        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--gw-mist)' }}>Loading…</div>
          ) : values.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--gw-mist)' }}>
              No values yet. Click <strong>+ Add Value</strong> to create one.
            </div>
          ) : values.map(v => {
            const count = counts[v] ?? 0
            const isSelected = selected.has(v)
            const isEditing = editing?.value === v
            return (
              <div
                key={v}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '40px 1fr 200px 100px',
                  padding: '10px 20px',
                  borderBottom: '1px solid var(--gw-border)',
                  alignItems: 'center',
                  background: isSelected ? 'var(--gw-sky)' : '#fff',
                  transition: 'background 100ms',
                }}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(v)}
                  style={{ cursor: 'pointer' }}
                />
                {isEditing ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      className="form-control"
                      autoFocus
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter')  handleEditSave()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                      style={{ flex: 1 }}
                    />
                    <button className="btn btn--primary btn--sm" onClick={handleEditSave}>Save</button>
                    <button className="btn btn--secondary btn--sm" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ fontSize: 14 }}>{v}</div>
                )}
                <div style={{
                  fontSize: 13,
                  color: count > 0 ? 'var(--gw-azure)' : 'var(--gw-mist)',
                  fontWeight: count > 0 ? 600 : 400,
                }}>
                  {loadingCounts ? '…' : count.toLocaleString()}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
                  {!isEditing && (
                    <>
                      <button
                        className="btn btn--ghost btn--icon"
                        title="Rename"
                        onClick={() => { setEditing({ value: v }); setEditDraft(v) }}
                      >
                        <Icon name="edit" size={13} />
                      </button>
                      <button
                        className="btn btn--ghost btn--icon"
                        title="Delete"
                        onClick={() => setConfirmDelete({ value: v, count })}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Add modal */}
      {adding && (
        <Modal open={true} onClose={() => { setAdding(false); setNewValue('') }} width={420}>
          <div className="modal__head">
            <div>
              <div className="eyebrow-label">{fieldLabel}</div>
              <h3 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--font-display)' }}>Add new value</h3>
            </div>
          </div>
          <div className="modal__body">
            <div className="form-group">
              <label className="form-label">Value</label>
              <input
                autoFocus
                className="form-control"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                placeholder={`New ${fieldLabel.toLowerCase()}…`}
              />
            </div>
          </div>
          <div className="modal__foot">
            <button className="btn btn--secondary" onClick={() => { setAdding(false); setNewValue('') }}>Cancel</button>
            <button className="btn btn--primary" onClick={handleAdd} disabled={!newValue.trim()}>Add</button>
          </div>
        </Modal>
      )}

      {/* Merge modal */}
      {merging && (
        <Modal open={true} onClose={() => setMerging(null)} width={480}>
          <div className="modal__head">
            <div>
              <div className="eyebrow-label">{fieldLabel}</div>
              <h3 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--font-display)' }}>Merge values</h3>
            </div>
          </div>
          <div className="modal__body">
            <p style={{ fontSize: 13, color: 'var(--gw-mist)', marginTop: 0 }}>
              Pick the value to keep. Other selected values will be replaced everywhere they're used.
              <strong> This cannot be undone.</strong>
            </p>
            <div className="form-group">
              <label className="form-label">Keep this value</label>
              <select
                className="form-control"
                value={merging.to}
                onChange={(e) => setMerging({ ...merging, to: e.target.value })}
              >
                {merging.from.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div style={{ background: 'var(--gw-bone)', padding: 12, borderRadius: 'var(--radius)', fontSize: 12 }}>
              <strong>Will be merged into "{merging.to}":</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {merging.from.filter(v => v !== merging.to).map(v => (
                  <li key={v}>{v} <span style={{ color: 'var(--gw-mist)' }}>({counts[v] ?? 0} records)</span></li>
                ))}
              </ul>
            </div>
          </div>
          <div className="modal__foot">
            <button className="btn btn--secondary" onClick={() => setMerging(null)}>Cancel</button>
            <button className="btn btn--primary" onClick={handleMergeConfirm}>Merge</button>
          </div>
        </Modal>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <ConfirmDialog
          message={
            confirmDelete.count > 0
              ? `"${confirmDelete.value}" is used by ${confirmDelete.count} record${confirmDelete.count !== 1 ? 's' : ''}. Delete anyway? The value will be removed from those records.`
              : `Delete "${confirmDelete.value}"?`
          }
          onConfirm={() => handleDelete(confirmDelete.value)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

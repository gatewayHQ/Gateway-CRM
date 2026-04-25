import React, { useState, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatCurrency, formatDate, STAGE_LABELS, STAGE_ORDER } from '../lib/helpers.js'
import { Icon, Badge, Avatar, Drawer, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'

function DealDrawer({ open, onClose, deal, agents, contacts, properties, onSave }) {
  const blank = { title:'', contact_id:'', property_id:'', agent_id:'', stage:'lead', value:'', probability:0, expected_close_date:'', notes:'' }
  const [form, setForm] = useState(deal || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  React.useEffect(() => { setForm(deal ? {...deal, expected_close_date: deal.expected_close_date ? deal.expected_close_date.slice(0,10) : ''} : blank); setErrors({}) }, [deal, open])
  const set = (k, v) => setForm(p => ({...p, [k]: v}))

  const save = async () => {
    const e = {}
    if (!form.title.trim()) e.title = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    const payload = { ...form, value: form.value ? Number(form.value) : null, probability: Number(form.probability) || 0, updated_at: new Date().toISOString() }
    let error
    if (deal?.id) {
      ({ error } = await supabase.from('deals').update(payload).eq('id', deal.id))
    } else {
      ({ error } = await supabase.from('deals').insert([payload]))
    }
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(deal?.id ? 'Deal updated' : 'Deal added')
    onSave(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title={deal?.id ? 'Edit Deal' : 'Add Deal'}>
      <div className="drawer__body">
        <div className="form-group"><label className="form-label required">Deal Title</label><input className={`form-control${errors.title?' error':''}`} value={form.title} onChange={e=>set('title',e.target.value)} placeholder="e.g. 123 Main St Purchase" /></div>
        <div className="form-group"><label className="form-label">Stage</label><select className="form-control" value={form.stage} onChange={e=>set('stage',e.target.value)}>{STAGE_ORDER.map(s=><option key={s} value={s}>{STAGE_LABELS[s]}</option>)}</select></div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Deal Value</label><input className="form-control" type="number" value={form.value||''} onChange={e=>set('value',e.target.value)} placeholder="0" /></div>
          <div className="form-group"><label className="form-label">Probability %</label><input className="form-control" type="number" min="0" max="100" value={form.probability||0} onChange={e=>set('probability',e.target.value)} /></div>
        </div>
        <div className="form-group"><label className="form-label">Expected Close Date</label><input className="form-control" type="date" value={form.expected_close_date||''} onChange={e=>set('expected_close_date',e.target.value)} /></div>
        <div className="form-group"><label className="form-label">Contact</label><SearchDropdown items={contacts} value={form.contact_id} onSelect={v=>set('contact_id',v)} placeholder="Search contacts…" labelKey={c=>`${c.first_name} ${c.last_name}`} /></div>
        <div className="form-group"><label className="form-label">Property</label><SearchDropdown items={properties} value={form.property_id} onSelect={v=>set('property_id',v)} placeholder="Search properties…" labelKey="address" /></div>
        <div className="form-group"><label className="form-label">Assigned Agent</label><select className="form-control" value={form.agent_id||''} onChange={e=>set('agent_id',e.target.value)}><option value="">Unassigned</option>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
        <div className="form-group"><label className="form-label">Notes</label><textarea className="form-control form-control--textarea" value={form.notes||''} onChange={e=>set('notes',e.target.value)} /></div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Deal'}</button>
      </div>
    </Drawer>
  )
}

export default function PipelinePage({ db, setDb, activeAgent }) {
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState(null)
  const [defaultStage, setDefaultStage] = useState('lead')
  const [confirm, setConfirm] = useState(null)
  const [dragging, setDragging] = useState(null)
  const [dragOver, setDragOver] = useState(null)

  const deals = db.deals || []
  const agents = db.agents || []
  const contacts = db.contacts || []
  const properties = db.properties || []

  const reload = async () => {
    const { data } = await supabase.from('deals').select('*').order('created_at', { ascending: false })
    setDb(p => ({ ...p, deals: data || [] }))
  }

  const del = async (id) => {
    await supabase.from('deals').delete().eq('id', id)
    pushToast('Deal deleted', 'info')
    setConfirm(null); reload()
  }

  const moveStage = async (dealId, newStage) => {
    await supabase.from('deals').update({ stage: newStage, updated_at: new Date().toISOString() }).eq('id', dealId)
    setDb(p => ({ ...p, deals: p.deals.map(d => d.id === dealId ? { ...d, stage: newStage } : d) }))
    pushToast(`Deal moved to ${STAGE_LABELS[newStage]}`)
  }

  const stageDeals = (stage) => deals.filter(d => d.stage === stage)
  const stageValue = (stage) => stageDeals(stage).reduce((s, d) => s + (d.value || 0), 0)

  return (
    <div className="page-content" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header">
        <div><div className="page-title">Pipeline</div><div className="page-sub">{deals.length} total deals · {formatCurrency(deals.reduce((s,d)=>s+(d.value||0),0))} total value</div></div>
        <button className="btn btn--primary" onClick={() => { setEditing(null); setDefaultStage('lead'); setDrawer(true) }}><Icon name="plus" size={14} /> Add Deal</button>
      </div>

      {deals.length === 0 ? (
        <EmptyState icon="pipeline" title="No deals yet" message="Add your first deal to start tracking your pipeline." action={<button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Deal</button>} />
      ) : (
        <div className="kanban-board">
          {STAGE_ORDER.map(stage => (
            <div key={stage} className="kanban-col">
              <div className="kanban-col__head">
                <div>
                  <div className="kanban-col__label">{STAGE_LABELS[stage]}</div>
                  {stageValue(stage) > 0 && <div style={{ fontSize:10, color:'var(--gw-mist)', marginTop:1 }}>{formatCurrency(stageValue(stage))}</div>}
                </div>
                <span className="kanban-col__count">{stageDeals(stage).length}</span>
              </div>
              <div
                className={`kanban-col__body${dragOver === stage ? ' drag-over' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragOver(stage) }}
                onDragLeave={() => setDragOver(null)}
                onDrop={e => { e.preventDefault(); if (dragging && dragging !== stage) moveStage(dragging, stage); setDragOver(null); setDragging(null) }}
              >
                {stageDeals(stage).map(deal => {
                  const contact = contacts.find(c => c.id === deal.contact_id)
                  const agent = agents.find(a => a.id === deal.agent_id)
                  const overdue = deal.expected_close_date && new Date(deal.expected_close_date) < new Date() && stage !== 'closed' && stage !== 'lost'
                  return (
                    <div key={deal.id} className={`deal-card${dragging === deal.id ? ' dragging' : ''}`}
                      draggable
                      onDragStart={() => setDragging(deal.id)}
                      onDragEnd={() => { setDragging(null); setDragOver(null) }}
                      onClick={() => { setEditing(deal); setDrawer(true) }}
                    >
                      <div className="deal-card__title">{deal.title}</div>
                      {contact && <div className="deal-card__contact">{contact.first_name} {contact.last_name}</div>}
                      {deal.value > 0 && <div className="deal-card__value">{formatCurrency(deal.value)}</div>}
                      <div className="deal-card__meta">
                        <div style={{ fontSize:11, color: overdue ? 'var(--gw-red)' : 'var(--gw-mist)' }}>
                          {deal.expected_close_date ? formatDate(deal.expected_close_date) : ''}
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                          {deal.probability > 0 && <span style={{ fontSize:10, color:'var(--gw-mist)' }}>{deal.probability}%</span>}
                          {agent && <Avatar agent={agent} size={20} />}
                          <button className="btn btn--ghost btn--icon" style={{ padding:2 }} onClick={e=>{e.stopPropagation(); setConfirm(deal.id)}}><Icon name="trash" size={11} /></button>
                        </div>
                      </div>
                    </div>
                  )
                })}
                <button className="btn btn--ghost" style={{ width:'100%', justifyContent:'center', fontSize:12, marginTop:'auto', borderStyle:'dashed', border:'1px dashed var(--gw-border)' }}
                  onClick={() => { setEditing(null); setDefaultStage(stage); setDrawer(true) }}>
                  <Icon name="plus" size={13} /> Add deal
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <DealDrawer open={drawer} onClose={() => setDrawer(false)} deal={editing ? editing : { stage: defaultStage }} agents={agents} contacts={contacts} properties={properties} onSave={reload} />
      {confirm && <ConfirmDialog message="This will permanently delete this deal." onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
    </div>
  )
}

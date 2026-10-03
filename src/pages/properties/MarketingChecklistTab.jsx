// Property drawer → Marketing checklist tab.

import React, { useState } from 'react'
import { Icon, pushToast } from '../../components/UI.jsx'
import { fetchListingChecklistSteps, createListingChecklistSteps, createListingChecklistStep, updateListingChecklistStep, deleteListingChecklistStep } from '../../lib/services/listingChecklist.js'

const DEFAULT_MARKETING_STEPS = [
  'Professional photos uploaded','Virtual tour created','Listed on MLS',
  'Syndicated to Zillow/Realtor.com','Social media posts scheduled',
  'Open house scheduled','Lockbox installed','Yard sign placed',
]

export function MarketingChecklistTab({ property }) {
  const [steps, setSteps]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [tableReady, setTableReady] = useState(true)
  const [newTitle, setNewTitle]   = useState('')
  const [adding, setAdding]       = useState(false)

  React.useEffect(() => { if (property?.id) loadSteps() }, [property?.id])

  const loadSteps = async () => {
    setLoading(true)
    const { data, error } = await fetchListingChecklistSteps(property.id)
    if (error?.code === '42P01') { setTableReady(false); setLoading(false); return }
    if ((data||[]).length === 0 && property.status === 'active') {
      const rows = DEFAULT_MARKETING_STEPS.map((title, i) => ({ property_id:property.id, title, completed:false, sort_order:i }))
      const { data: created } = await createListingChecklistSteps(rows)
      setSteps(created || [])
      pushToast('Marketing checklist created', 'info')
    } else {
      setSteps(data || [])
    }
    setLoading(false)
  }

  const toggle = async (step) => {
    const now = new Date().toISOString()
    const patch = { completed:!step.completed, completed_at:!step.completed ? now : null }
    await updateListingChecklistStep(step.id, patch)
    setSteps(p => p.map(s => s.id === step.id ? { ...s, ...patch } : s))
  }

  const addStep = async () => {
    if (!newTitle.trim()) return
    setAdding(true)
    const { data, error } = await createListingChecklistStep({
      property_id:property.id, title:newTitle.trim(), completed:false, sort_order:steps.length,
    })
    setAdding(false)
    if (error) { pushToast(error.message, 'error'); return }
    setSteps(p => [...p, data]); setNewTitle('')
  }

  const removeStep = async (id) => {
    await deleteListingChecklistStep(id)
    setSteps(p => p.filter(s => s.id !== id))
  }

  if (!tableReady) return (
    <div style={{ padding:20 }}>
      <div style={{ background:'#fff8ec', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:16, fontSize:13, lineHeight:1.7 }}>
        <strong>Run this SQL in Supabase Dashboard → SQL Editor:</strong>
        <pre style={{ background:'var(--gw-slate)', color:'#e2e8f0', padding:10, borderRadius:6, fontSize:11, marginTop:8, overflowX:'auto' }}>
{`create table if not exists listing_checklist_steps (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid references properties(id) on delete cascade,
  title        text not null,
  completed    boolean default false,
  completed_at timestamptz,
  sort_order   int default 0,
  created_at   timestamptz default now()
);
alter table listing_checklist_steps enable row level security;
create policy "agents_listing_checklist" on listing_checklist_steps
  for all to authenticated using (true) with check (true);`}
        </pre>
        <button className="btn btn--secondary btn--sm" style={{ marginTop:8 }} onClick={() => { setTableReady(true); loadSteps() }}>
          <Icon name="refresh" size={12} /> Retry
        </button>
      </div>
    </div>
  )

  if (loading) return <div style={{ padding:24, fontSize:13, color:'var(--gw-mist)' }}>Loading checklist…</div>

  const doneCount = steps.filter(s => s.completed).length
  const pct = steps.length > 0 ? Math.round(doneCount / steps.length * 100) : 0

  return (
    <div style={{ padding:16, overflowY:'auto', flex:1 }}>
      {steps.length > 0 && (
        <div style={{ marginBottom:16 }}>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, fontWeight:600, marginBottom:6 }}>
            <span>{doneCount}/{steps.length} complete</span>
            <span style={{ color: pct === 100 ? 'var(--gw-green)' : 'var(--gw-mist)' }}>{pct}%</span>
          </div>
          <div style={{ height:6, background:'var(--gw-border)', borderRadius:3, overflow:'hidden' }}>
            <div style={{ width:`${pct}%`, height:'100%', background: pct === 100 ? 'var(--gw-green)' : 'var(--gw-azure)', borderRadius:3, transition:'width 300ms ease' }} />
          </div>
        </div>
      )}
      {steps.length === 0 && property.status !== 'active' && (
        <div style={{ textAlign:'center', padding:'20px 0', color:'var(--gw-mist)', fontSize:13 }}>
          Checklist auto-creates when status is <strong>Active</strong>.<br/>Or add steps manually below.
        </div>
      )}
      {steps.map(step => (
        <div key={step.id} onClick={() => toggle(step)}
          style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 10px', borderRadius:'var(--radius)', cursor:'pointer', marginBottom:3, transition:'background 120ms' }}
          onMouseEnter={e=>e.currentTarget.style.background='var(--gw-bone)'}
          onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
          <div style={{ width:20, height:20, borderRadius:4, border:`2px solid ${step.completed?'var(--gw-green)':'var(--gw-border)'}`, background:step.completed?'var(--gw-green)':'#fff', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'all 150ms' }}>
            {step.completed && <Icon name="check" size={11} style={{ color:'#fff' }} />}
          </div>
          <span style={{ flex:1, fontSize:13, textDecoration:step.completed?'line-through':'none', color:step.completed?'var(--gw-mist)':'var(--gw-ink)' }}>{step.title}</span>
          {step.completed && step.completed_at && (
            <span style={{ fontSize:10, color:'var(--gw-mist)', whiteSpace:'nowrap' }}>
              {new Date(step.completed_at).toLocaleDateString('en-US', { month:'short', day:'numeric' })}
            </span>
          )}
          <button className="btn btn--ghost btn--icon" style={{ padding:2, opacity:0.4 }}
            onClick={e=>{e.stopPropagation();removeStep(step.id)}}><Icon name="x" size={11} /></button>
        </div>
      ))}
      <div style={{ display:'flex', gap:8, marginTop:12 }}>
        <input className="form-control" style={{ flex:1, fontSize:13 }} placeholder="Add a step…"
          value={newTitle} onChange={e=>setNewTitle(e.target.value)}
          onKeyDown={e=>e.key==='Enter'&&addStep()} disabled={adding} />
        <button className="btn btn--secondary btn--sm" onClick={addStep} disabled={adding||!newTitle.trim()}>Add</button>
      </div>
    </div>
  )
}

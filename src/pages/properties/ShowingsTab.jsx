// Property drawer → Showings tab.

import React, { useState } from 'react'
import { Icon, pushToast } from '../../components/UI.jsx'
import { fetchPropertyShowings, createPropertyShowing, deletePropertyShowing } from '../../lib/services/propertyShowings.js'

// ─── Listing drawer tab components ───────────────────────────────────────────

export function ShowingsTab({ property }) {
  const [showings, setShowings]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [tableReady, setTableReady] = useState(true)
  const [showForm, setShowForm]   = useState(false)
  const [adding, setAdding]       = useState(false)
  const [form, setForm]           = useState({ showing_date:'', buyer_agent_name:'', feedback:'', rating:'' })

  React.useEffect(() => { if (property?.id) loadShowings() }, [property?.id])

  const loadShowings = async () => {
    setLoading(true)
    const { data, error } = await fetchPropertyShowings(property.id)
    if (error?.code === '42P01') { setTableReady(false); setLoading(false); return }
    setShowings(data || [])
    setLoading(false)
  }

  const add = async () => {
    if (!form.showing_date) { pushToast('Date is required', 'error'); return }
    setAdding(true)
    const { data, error } = await createPropertyShowing({
      property_id: property.id,
      showing_date: form.showing_date,
      buyer_agent_name: form.buyer_agent_name || null,
      feedback: form.feedback || null,
      rating: form.rating ? Number(form.rating) : null,
    })
    setAdding(false)
    if (error) { pushToast(error.message, 'error'); return }
    setShowings(p => [data, ...p])
    setForm({ showing_date:'', buyer_agent_name:'', feedback:'', rating:'' })
    setShowForm(false)
    pushToast('Showing logged')
  }

  const remove = async (id) => {
    await deletePropertyShowing(id)
    setShowings(p => p.filter(s => s.id !== id))
  }

  if (!tableReady) return (
    <div style={{ padding:20 }}>
      <div style={{ background:'#fff8ec', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:16, fontSize:13, lineHeight:1.7 }}>
        <strong>Run this SQL in Supabase Dashboard → SQL Editor:</strong>
        <pre style={{ background:'var(--gw-slate)', color:'#e2e8f0', padding:10, borderRadius:6, fontSize:11, marginTop:8, overflowX:'auto' }}>
{`create table if not exists property_showings (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid references properties(id) on delete cascade,
  agent_id          uuid references agents(id) on delete set null,
  showing_date      timestamptz not null,
  buyer_agent_name  text,
  feedback          text,
  rating            int check (rating between 1 and 5),
  created_at        timestamptz default now()
);
alter table property_showings enable row level security;
create policy "agents_showings" on property_showings
  for all to authenticated using (true) with check (true);`}
        </pre>
        <button className="btn btn--secondary btn--sm" style={{ marginTop:8 }} onClick={() => { setTableReady(true); loadShowings() }}>
          <Icon name="refresh" size={12} /> Retry
        </button>
      </div>
    </div>
  )

  return (
    <div style={{ padding:16, overflowY:'auto', flex:1 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <div style={{ fontSize:12, color:'var(--gw-mist)' }}>{showings.length} showing{showings.length !== 1 ? 's' : ''}</div>
        <button className="btn btn--primary btn--sm" onClick={() => setShowForm(p => !p)}>
          <Icon name="plus" size={13} /> Log Showing
        </button>
      </div>
      {showForm && (
        <div style={{ background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:14, marginBottom:14 }}>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Date &amp; Time</label><input className="form-control" type="datetime-local" value={form.showing_date} onChange={e=>setForm(p=>({...p,showing_date:e.target.value}))} /></div>
            <div className="form-group"><label className="form-label">Buyer's Agent</label><input className="form-control" value={form.buyer_agent_name} onChange={e=>setForm(p=>({...p,buyer_agent_name:e.target.value}))} placeholder="Agent name" /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Feedback</label><input className="form-control" value={form.feedback} onChange={e=>setForm(p=>({...p,feedback:e.target.value}))} placeholder="Buyer's reaction…" /></div>
            <div className="form-group"><label className="form-label">Rating (1–5)</label>
              <select className="form-control" value={form.rating} onChange={e=>setForm(p=>({...p,rating:e.target.value}))}>
                <option value="">—</option>{[1,2,3,4,5].map(r=><option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
            <button className="btn btn--secondary btn--sm" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn--primary btn--sm" onClick={add} disabled={adding}>{adding ? 'Saving…' : 'Log Showing'}</button>
          </div>
        </div>
      )}
      {loading ? <div style={{ fontSize:13, color:'var(--gw-mist)' }}>Loading…</div>
        : showings.length === 0 ? <div style={{ textAlign:'center', color:'var(--gw-mist)', fontSize:13, padding:'24px 0' }}>No showings logged yet.</div>
        : showings.map(s => (
          <div key={s.id} style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:8, background:'#fff' }}>
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:600 }}>
                  {new Date(s.showing_date).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' })}
                  {s.rating && <span style={{ marginLeft:8, fontSize:12 }}>{'★'.repeat(s.rating)}{'☆'.repeat(5-s.rating)}</span>}
                </div>
                {s.buyer_agent_name && <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:2 }}>{s.buyer_agent_name}</div>}
                {s.feedback && <div style={{ fontSize:12, color:'var(--gw-ink)', marginTop:4, fontStyle:'italic' }}>"{s.feedback}"</div>}
              </div>
              <button className="btn btn--ghost btn--icon btn--sm" onClick={() => remove(s.id)}><Icon name="trash" size={12} /></button>
            </div>
          </div>
        ))
      }
    </div>
  )
}

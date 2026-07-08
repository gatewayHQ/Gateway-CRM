// ─────────────────────────────────────────────────────────────────────────────
// BoldSign admin panel (Settings → admin only)
//   • Sender identities — register each agent so their signature requests come
//     from them; track the Pending → Approved lifecycle; resend/sync.
//   • Templates — register the reusable BoldSign templates the deal Signatures
//     tab sends from, and open BoldSign's editor to build/adjust one.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, pushToast } from '../../components/UI.jsx'
import { OPERATING_STATES } from '../../lib/constants.js'
import {
  createIdentity, syncIdentities, resendIdentity,
  templateEditorUrl,
} from '../../lib/services/boldsign.js'

const STATUS_STYLE = {
  approved: { bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  pending:  { bg: '#fff3cd',               color: '#856404' },
  declined: { bg: 'var(--gw-red-light)',   color: 'var(--gw-red)' },
  none:     { bg: 'var(--gw-bone)',        color: 'var(--gw-mist)' },
}

const fileToBase64 = f => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = e => res(e.target.result.split(',')[1])
  r.onerror = rej
  r.readAsDataURL(f)
})

export default function BoldSignAdmin({ agents = [] }) {
  const [identities, setIdentities] = useState([])
  const [templates,  setTemplates]  = useState([])
  const [busy,       setBusy]        = useState('')

  const load = async () => {
    const [{ data: ids }, { data: tpls }] = await Promise.all([
      supabase.from('boldsign_sender_identities').select('*'),
      supabase.from('boldsign_templates').select('*').order('created_at', { ascending: false }),
    ])
    setIdentities(ids || [])
    setTemplates(tpls || [])
  }
  useEffect(() => { load() }, [])

  const idByAgent = Object.fromEntries(identities.map(i => [i.agent_id, i]))

  const register = async (agent) => {
    if (!agent.email) { pushToast(`${agent.name} has no email`, 'error'); return }
    setBusy(agent.id)
    try {
      await createIdentity(agent.id, agent.name, agent.email)
      pushToast(`Invitation sent to ${agent.email}`, 'success')
      await load()
    } catch (e) { pushToast(e.message, 'error') } finally { setBusy('') }
  }

  const resend = async (email) => {
    setBusy(email)
    try { await resendIdentity(email); pushToast('Invitation resent', 'success') }
    catch (e) { pushToast(e.message, 'error') } finally { setBusy('') }
  }

  const sync = async () => {
    setBusy('sync')
    try { const r = await syncIdentities(); pushToast(`Synced ${r.count} identities`, 'success'); await load() }
    catch (e) { pushToast(e.message, 'error') } finally { setBusy('') }
  }

  return (
    <>
      {/* ── Sender identities ─────────────────────────────────────────────── */}
      <div className="settings-section">
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div className="settings-section__title">BoldSign — Sender Identities</div>
            <div className="settings-section__sub">
              Register each agent so signature requests are sent from them. The agent must click the
              approval link BoldSign emails before their sends go out under their name.
            </div>
          </div>
          <button className="btn btn--secondary btn--sm" onClick={sync} disabled={busy==='sync'}>
            <Icon name="refresh" size={13}/> {busy==='sync' ? 'Syncing…' : 'Sync statuses'}
          </button>
        </div>
        <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
          {agents.length === 0
            ? <div style={{ padding:14, fontSize:13, color:'var(--gw-mist)' }}>No agents yet.</div>
            : agents.map((a, i) => {
                const id = idByAgent[a.id]
                const status = id?.status || 'none'
                const st = STATUS_STYLE[status] || STATUS_STYLE.none
                return (
                  <div key={a.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderTop: i ? '1px solid var(--gw-border)' : 'none' }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600 }}>{a.name}</div>
                      <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{a.email || 'no email'}</div>
                    </div>
                    <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700, background:st.bg, color:st.color, textTransform:'capitalize' }}>
                      {status === 'none' ? 'not registered' : status}
                    </span>
                    {status === 'none' && (
                      <button className="btn btn--primary btn--sm" onClick={() => register(a)} disabled={busy===a.id}>
                        {busy===a.id ? 'Sending…' : 'Register'}
                      </button>
                    )}
                    {status === 'pending' && (
                      <button className="btn btn--secondary btn--sm" onClick={() => resend(a.email)} disabled={busy===a.email}>
                        {busy===a.email ? 'Resending…' : 'Resend'}
                      </button>
                    )}
                  </div>
                )
              })}
        </div>
      </div>

      {/* ── Templates ─────────────────────────────────────────────────────── */}
      <TemplatesPanel templates={templates} onChange={load} />
    </>
  )
}

function TemplatesPanel({ templates, onChange }) {
  const [name,     setName]     = useState('')
  const [tid,      setTid]      = useState('')
  const [docType,  setDocType]  = useState('')
  const [state,    setState]    = useState('')
  const [tokens,   setTokens]   = useState('')
  const [saving,   setSaving]   = useState(false)
  const [editorBusy, setEditorBusy] = useState(false)
  const fileRef = useRef()

  const openEditor = async (file) => {
    if (!file) return
    setEditorBusy(true)
    try {
      const documentBase64 = await fileToBase64(file)
      const { url, templateId } = await templateEditorUrl({
        title: file.name.replace(/\.pdf$/i, ''),
        documentBase64, documentName: file.name,
        redirectUrl: window.location.href,
      })
      if (templateId) setTid(templateId)
      if (url) window.open(url, '_blank', 'noopener')
      pushToast('Opened BoldSign editor — place fields, then register the template id below', 'success')
    } catch (e) { pushToast(e.message, 'error') } finally { setEditorBusy(false) }
  }

  const register = async () => {
    if (!name.trim() || !tid.trim()) { pushToast('Name and template id are required', 'error'); return }
    setSaving(true)
    const field_tokens = tokens.split(',').map(s => s.trim()).filter(Boolean)
    const { error } = await supabase.from('boldsign_templates').upsert({
      template_id: tid.trim(), name: name.trim(), doc_type: docType.trim() || null,
      state: state.trim().toUpperCase() || null,
      field_tokens, active: true,
    }, { onConflict: 'template_id' })
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast('Template registered', 'success')
    setName(''); setTid(''); setDocType(''); setState(''); setTokens('')
    onChange()
  }

  const toggleActive = async (t) => {
    await supabase.from('boldsign_templates').update({ active: !t.active }).eq('id', t.id)
    onChange()
  }

  return (
    <div className="settings-section">
      <div className="settings-section__title">BoldSign — Templates</div>
      <div className="settings-section__sub">
        Reusable documents the deal Signatures tab can send with CRM data pre-filled. Build one in
        BoldSign's editor, then register its template id and the field tokens it fills.
      </div>

      {templates.length > 0 && (
        <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden', marginBottom:16 }}>
          {templates.map((t, i) => (
            <div key={t.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderTop: i ? '1px solid var(--gw-border)' : 'none', opacity: t.active ? 1 : 0.5 }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:600 }}>
                  {t.name}
                  {t.state && <span style={{ marginLeft:8, padding:'1px 6px', borderRadius:8, fontSize:10, fontWeight:700, background:'var(--gw-sky)', color:'var(--gw-azure)' }}>{t.state}</span>}
                </div>
                <div style={{ fontSize:11, color:'var(--gw-mist)', fontFamily:'var(--font-mono)' }}>{t.template_id}</div>
                {t.field_tokens?.length > 0 && <div style={{ fontSize:11, color:'var(--gw-mist)' }}>fills: {t.field_tokens.join(', ')}</div>}
              </div>
              <button className="btn btn--ghost btn--sm" onClick={() => toggleActive(t)}>{t.active ? 'Disable' : 'Enable'}</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:14 }}>
        <div style={{ fontSize:12, fontWeight:700, marginBottom:10 }}>Register a template</div>
        <div style={{ display:'flex', gap:8, marginBottom:8, flexWrap:'wrap' }}>
          <button className="btn btn--secondary btn--sm" onClick={() => fileRef.current?.click()} disabled={editorBusy}>
            <Icon name="upload" size={13}/> {editorBusy ? 'Opening…' : 'Build new in BoldSign (upload PDF)'}
          </button>
          <input ref={fileRef} type="file" accept=".pdf" style={{ display:'none' }} onChange={e => openEditor(e.target.files[0])}/>
        </div>
        <div style={{ display:'grid', gap:8 }}>
          <input className="form-control" placeholder="Template name (e.g. Iowa Listing Agreement)" value={name} onChange={e => setName(e.target.value)}/>
          <input className="form-control" placeholder="BoldSign template id" value={tid} onChange={e => setTid(e.target.value)}/>
          <div style={{ display:'flex', gap:8 }}>
            <input className="form-control" style={{ flex:2 }} placeholder="Doc type (e.g. listing_agreement)" value={docType} onChange={e => setDocType(e.target.value)}/>
            <select className="form-control" style={{ flex:1 }} value={state} onChange={e => setState(e.target.value)}>
              <option value="">Any state</option>
              {OPERATING_STATES.map(s => <option key={s.code} value={s.code}>{s.code}</option>)}
            </select>
          </div>
          <input className="form-control" placeholder="Field tokens, comma-separated (e.g. property_address, list_price, seller_name)" value={tokens} onChange={e => setTokens(e.target.value)}/>
          <button className="btn btn--primary btn--sm" onClick={register} disabled={saving} style={{ justifySelf:'start' }}>
            {saving ? 'Saving…' : 'Register template'}
          </button>
        </div>
      </div>
    </div>
  )
}

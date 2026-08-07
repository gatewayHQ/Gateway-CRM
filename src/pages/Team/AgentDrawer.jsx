import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../../lib/supabase.js'
import { compressForUpload, IMMUTABLE_CACHE } from '../../lib/imageCompress.js'
import { saveAgentProfile } from '../../lib/services/agentProfile.js'
import { Icon, Drawer, pushToast } from '../../components/UI.jsx'

const COLORS = ['#2d3561','#4a6fa5','#2e7d5e','#c9a84c','#6b4fa5','#c0392b','#d4820a','#1a1a2e']
const DEFAULT_SPLIT = 70
const BLANK  = { name: '', initials: '', role: '', email: '', phone: '', color: '#2d3561', photo_url: '', bio: '',
                 tagline: '', stats: [],
                 default_split_pct: DEFAULT_SPLIT, no_brokerage_split: false, is_admin: false }
const BIO_MAX = 600

const autoInitials = (name) =>
  name.trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2)

// The split is edited as free text so the field can be emptied mid-keystroke.
// Valid = a number in 0-100; blank is invalid rather than a silent 0, because
// "" coerced to 0 is how an agent's 70% quietly became a 0% take.
const splitError = (raw) => {
  const s = String(raw ?? '').trim()
  if (!s) return 'Enter the agent’s split percentage.'
  const n = Number(s)
  if (!Number.isFinite(n)) return 'Split must be a number.'
  if (n < 0 || n > 100)    return 'Split must be between 0 and 100.'
  return null
}

export default function AgentDrawer({ open, onClose, agent, onSave, isAdmin = false, activeAgent }) {
  // RBAC: privileged fields (role, admin flag, commission split) are editable
  // only by an office admin. A regular agent editing their own profile sees just
  // the personal fields; the server (api/portal profile-save) + DB RLS enforce
  // the same rule even if the UI is bypassed.
  const isSelf = !!agent?.id && agent.id === activeAgent?.id
  const [form,   setForm]   = useState(BLANK)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    setForm(agent
      ? {
          ...BLANK,
          ...agent,
          stats: Array.isArray(agent.stats) ? agent.stats : [],
          // A null split in the database would make this a controlled→
          // uncontrolled input; show the house default instead of blank.
          default_split_pct: agent.default_split_pct ?? DEFAULT_SPLIT,
        }
      : BLANK)
    setErrors({})
  }, [agent, open])

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  // ── Stats editor (curated public vanity figures) ──────────────────────────
  const stats = Array.isArray(form.stats) ? form.stats : []
  const setStat   = (i, patch) => set('stats', stats.map((s, j) => j === i ? { ...s, ...patch } : s))
  const addStat   = () => stats.length < 4 && set('stats', [...stats, { label: '', value: '' }])
  const removeStat = (i) => set('stats', stats.filter((_, j) => j !== i))

  const profileUrl = agent?.id ? `${window.location.origin}/advisor/${agent.id}` : ''
  const copy = async (text, label) => {
    try { await navigator.clipboard.writeText(text); pushToast(`${label} copied`) }
    catch { pushToast('Could not copy — copy it manually', 'error') }
  }
  const signatureHtml = () => {
    const a = form
    const line = (t) => t ? `${t}` : ''
    return [
      `<table cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;color:#1a1a2e;font-size:13px;line-height:1.5">`,
      `<tr><td style="padding-right:14px;vertical-align:top">`,
      a.photo_url ? `<img src="${a.photo_url}" width="64" height="64" style="border-radius:8px;display:block" alt="${a.name}">` : '',
      `</td><td style="vertical-align:top">`,
      `<div style="font-weight:bold;font-size:15px">${line(a.name)}</div>`,
      `<div style="color:#6b6b6b">${line(a.role || 'Real Estate Advisor')} · Gateway Real Estate Advisors</div>`,
      a.phone ? `<div><a href="tel:${a.phone}" style="color:#c9a961;text-decoration:none">${a.phone}</a></div>` : '',
      a.email ? `<div><a href="mailto:${a.email}" style="color:#c9a961;text-decoration:none">${a.email}</a></div>` : '',
      profileUrl ? `<div style="margin-top:4px"><a href="${profileUrl}" style="color:#c9a961">About me →</a></div>` : '',
      `</td></tr></table>`,
    ].filter(Boolean).join('')
  }

  const uploadHeadshot = async (file) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { pushToast('Please choose an image file', 'error'); return }
    setUploading(true)
    try {
      const { blob, ext, type } = await compressForUpload(file, 'headshot')
      const path = `agents/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage
        .from('campaign-images').upload(path, blob, { contentType: type, upsert: false, cacheControl: IMMUTABLE_CACHE })
      if (error) throw error
      const { data: { publicUrl } } = supabase.storage.from('campaign-images').getPublicUrl(path)
      set('photo_url', publicUrl)
    } catch (e) {
      pushToast(e.message || 'Upload failed — try again', 'error')
    } finally {
      setUploading(false)
    }
  }

  const save = async () => {
    const e = {}
    if (!form.name.trim())  e.name  = true
    if (!form.email.trim()) e.email = true
    // Only an admin can send the split at all, so only validate what we'll send.
    const splitMsg = isAdmin && !form.no_brokerage_split ? splitError(form.default_split_pct) : null
    if (splitMsg) e.split = splitMsg
    setErrors(e)
    if (Object.keys(e).length) {
      if (splitMsg) pushToast(splitMsg, 'error')
      return
    }

    setSaving(true)
    // Send the full form; the server whitelists columns by role, so privileged
    // fields sent by a non-admin are simply ignored (never trusted client-side).
    const payload = {
      id:        agent?.id || undefined,
      name:      form.name.trim(),
      initials:  form.initials || autoInitials(form.name),
      email:     form.email.trim(),
      phone:     (form.phone || '').trim() || null,
      photo_url: form.photo_url || null,
      bio:       form.bio || null,
      tagline:   (form.tagline || '').trim() || null,
      color:     form.color,
      stats: (Array.isArray(form.stats) ? form.stats : [])
        .map(s => ({ label: (s.label || '').trim(), value: (s.value || '').trim() }))
        .filter(s => s.label || s.value),
    }

    // Privileged fields only travel when an admin actually edited them. A
    // non-admin's copy would be dropped by the server anyway, but sending it
    // would also mean a plain agent saving their bio re-submits a split they
    // never saw — and any drift in that stale value looks like a silent change.
    if (isAdmin) {
      payload.role               = form.role
      payload.is_admin           = !!form.is_admin
      payload.no_brokerage_split = !!form.no_brokerage_split
      // "Keeps 100%" is the split, not an excuse to blank the field: store 100
      // so reports and the commission editor read the same number the UI shows.
      payload.default_split_pct  = form.no_brokerage_split ? 100 : Number(form.default_split_pct)
    }

    try {
      const saved = await saveAgentProfile(payload)
      pushToast(agent?.id ? 'Profile updated' : 'Agent added')
      // Hand back the row the DATABASE stored, not the values we sent — the
      // caller mirrors it into state so the UI can't show a save that didn't
      // land (see src/lib/services/agentProfile.js).
      onSave(saved)
      onClose()
    } catch (err) {
      pushToast(err.message || 'Could not save profile', 'error')
    } finally {
      setSaving(false)
    }
  }

  const previewInitials = form.initials || autoInitials(form.name) || '?'

  return (
    <Drawer open={open} onClose={onClose} title={agent?.id ? 'Edit Agent' : 'Add Agent'} width={400}>
      <div className="drawer__body">
        {/* Headshot — what shows on QR landing pages */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          {form.photo_url ? (
            <img src={form.photo_url} alt="Headshot preview"
                 style={{ width: 84, height: 84, borderRadius: 16, objectFit: 'cover' }} />
          ) : (
            <div style={{ width: 84, height: 84, borderRadius: 16, background: form.color,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 30, fontWeight: 700, color: '#fff' }}>
              {previewInitials}
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                 onChange={e => uploadHeadshot(e.target.files?.[0])} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn--secondary btn--sm" disabled={uploading}
                    onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={12} /> {uploading ? 'Uploading…' : form.photo_url ? 'Replace headshot' : 'Upload headshot'}
            </button>
            {form.photo_url && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => set('photo_url', '')}>
                Remove
              </button>
            )}
          </div>
          <div className="form-hint" style={{ textAlign: 'center' }}>Shown on your QR landing pages</div>
        </div>

        <div className="form-group">
          <label className="form-label required">Full Name</label>
          <input className={`form-control${errors.name ? ' error' : ''}`} value={form.name}
            onChange={e => set('name', e.target.value)} placeholder="Jane Smith" />
        </div>
        <div className="form-group">
          <label className="form-label">Initials</label>
          <input className="form-control" value={form.initials}
            onChange={e => set('initials', e.target.value.toUpperCase().slice(0, 2))}
            placeholder="Auto-generated" maxLength={2} />
          <div className="form-hint">Used when no headshot is set. Leave blank to auto-generate.</div>
        </div>
        <div className="form-group">
          <label className="form-label">Role / Title</label>
          <input className="form-control" value={form.role} disabled={!isAdmin}
            onChange={e => set('role', e.target.value)} placeholder="Lead Agent, Buyer's Advisor…" />
          {!isAdmin && <div className="form-hint">Only an admin can change your role/title.</div>}
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label required">Email</label>
            <input className={`form-control${errors.email ? ' error' : ''}`} type="email" value={form.email}
              onChange={e => set('email', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Phone</label>
            <input className="form-control" type="tel" value={form.phone || ''}
              onChange={e => set('phone', e.target.value)} placeholder="(555) 000-0000" />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Tagline</label>
          <input className="form-control" value={form.tagline || ''}
            onChange={e => set('tagline', e.target.value)}
            placeholder="Multifamily & investment sales, Sioux City" />
          <div className="form-hint">One line shown under your name on your advisor profile.</div>
        </div>

        <div className="form-group">
          <label className="form-label">Bio</label>
          <textarea className="form-control form-control--textarea" rows={4} maxLength={BIO_MAX}
            value={form.bio || ''} onChange={e => set('bio', e.target.value)}
            placeholder="A few sentences clients will see on your landing pages — your focus, experience, and what makes working with you great." />
          <div className="form-hint">{(form.bio || '').length}/{BIO_MAX} · Appears in the “Meet your advisor” section.</div>
        </div>

        {/* Stats — curated public figures for the advisor profile */}
        <div className="form-group">
          <label className="form-label">Stats <span style={{ fontWeight:400, color:'var(--gw-mist)' }}>(up to 4)</span></label>
          {stats.map((s, i) => (
            <div key={i} style={{ display:'flex', gap:8, marginBottom:8 }}>
              <input className="form-control" value={s.value} style={{ flex:'0 0 38%' }}
                onChange={e => setStat(i, { value: e.target.value })} placeholder="$240M+" />
              <input className="form-control" value={s.label} style={{ flex:1 }}
                onChange={e => setStat(i, { label: e.target.value })} placeholder="Closed volume" />
              <button type="button" className="btn btn--ghost btn--icon btn--sm" title="Remove" onClick={() => removeStat(i)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
          {stats.length < 4 && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={addStat}>
              <Icon name="plus" size={12} /> Add stat
            </button>
          )}
          <div className="form-hint">Vanity figures you control (volume, years, deals). Not pulled from commissions.</div>
        </div>

        {/* Shareable advisor profile + email signature */}
        {agent?.id && (
          <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)',
                        padding:'12px 14px', marginBottom:16 }}>
            <div style={{ fontSize:12, fontWeight:700, marginBottom:8 }}>Shareable profile</div>
            <div style={{ fontSize:12, color:'var(--gw-mist)', wordBreak:'break-all', marginBottom:10 }}>{profileUrl}</div>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => copy(profileUrl, 'Profile link')}>
                <Icon name="copy" size={12} /> Copy link
              </button>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => copy(signatureHtml(), 'Signature HTML')}>
                <Icon name="mail" size={12} /> Copy email-signature HTML
              </button>
              <a className="btn btn--ghost btn--sm" href={profileUrl} target="_blank" rel="noreferrer">
                <Icon name="link" size={12} /> Preview
              </a>
            </div>
            <div className="form-hint" style={{ marginTop:8 }}>Save first to capture any edits. Paste the signature HTML into Gmail/Outlook.</div>
          </div>
        )}

        {/* ── Commission & access ─────────────────────────────────────────── */}
        {/* Admins edit; an agent viewing their own profile sees their split
            read-only. Hiding it entirely was worse than useless — the number
            drives their pay and they had no way to check what it says. */}
        {(isAdmin || isSelf) && (
        <div style={{ borderTop: '1px solid var(--gw-border)', margin: '4px 0 16px', paddingTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gw-ink)', marginBottom: 12 }}>Commission &amp; Access</div>

          {isAdmin ? (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!form.no_brokerage_split}
                  onChange={e => set('no_brokerage_split', e.target.checked)} />
                <span>Keeps <strong>100%</strong> — no brokerage split (capped / special arrangement)</span>
              </label>

              {!form.no_brokerage_split && (
                <div className="form-group">
                  <label className="form-label">Default commission split (%)</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input className={`form-control${errors.split ? ' error' : ''}`} type="number"
                      min="0" max="100" step="1" style={{ width: 110 }}
                      value={form.default_split_pct ?? ''}
                      onChange={e => { set('default_split_pct', e.target.value); if (errors.split) setErrors(p => ({ ...p, split: null })) }}
                      onBlur={e => setErrors(p => ({ ...p, split: splitError(e.target.value) }))} />
                    <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>
                      {splitError(form.default_split_pct)
                        ? '—'
                        : <>agent <strong style={{ color: 'var(--gw-ink)' }}>{Number(form.default_split_pct)}%</strong> · brokerage {100 - Number(form.default_split_pct)}%</>}
                    </span>
                  </div>
                  {errors.split
                    ? <div className="form-hint" style={{ color: 'var(--gw-red)' }}>{errors.split}</div>
                    : <div className="form-hint">This agent's share; the brokerage keeps the rest. Pre-fills the commission editor.</div>}
                </div>
              )}

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!form.is_admin}
                  onChange={e => set('is_admin', e.target.checked)} />
                <span><strong>Office admin</strong> — can view every agent's deals, documents, signatures &amp; commissions</span>
              </label>
            </>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--gw-slate)' }}>
              {form.no_brokerage_split
                ? <>You keep <strong>100%</strong> — no brokerage split.</>
                : <>Your split: <strong>{form.default_split_pct ?? DEFAULT_SPLIT}%</strong> to you, {100 - Number(form.default_split_pct ?? DEFAULT_SPLIT)}% to the brokerage.</>}
              <div className="form-hint">Only an office admin can change this.</div>
            </div>
          )}
        </div>
        )}

        <div className="form-group">
          <label className="form-label">Avatar Color</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {COLORS.map(c => (
              <div key={c} onClick={() => set('color', c)} style={{
                width: 28, height: 28, borderRadius: 6, background: c, cursor: 'pointer',
                border: form.color === c ? '3px solid var(--gw-ink)' : '3px solid transparent',
                transition: 'border 150ms',
              }} />
            ))}
          </div>
          <div className="form-hint">Used for the initials badge when there’s no headshot.</div>
        </div>
      </div>

      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving || uploading}>
          {saving ? 'Saving…' : 'Save Agent'}
        </button>
      </div>
    </Drawer>
  )
}

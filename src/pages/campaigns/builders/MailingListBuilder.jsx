import React, { useState } from 'react'
import { Icon, pushToast } from '../../../components/UI.jsx'
import { fieldLabel, uploadImageToStorage } from './imageUpload.js'
import { OmUploadField } from './OmUploadField.jsx'

// ─── Mailing-List landing config builder ─────────────────────────────────────
// Powers landing_type='mailing'. Every field here maps 1:1 to what the public
// LandingMailing page renders — headings, CTA, submit button, theme, perks.

export function MailingListBuilder({ cfg, setCfg }) {
  const [uploading, setUploading] = useState({})
  const [aiOpen, setAiOpen]       = useState(false)
  const [aiInput, setAiInput]     = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  const theme = cfg.theme === 'light' ? 'light' : 'dark'
  const perks = Array.isArray(cfg.perks) ? cfg.perks : []
  const highlights = Array.isArray(cfg.highlights) ? cfg.highlights : []
  const heroUrl = (Array.isArray(cfg.images) && cfg.images[0])
    ? (typeof cfg.images[0] === 'string' ? cfg.images[0] : cfg.images[0].url) : ''

  const setPerkAt   = (i, v) => { const n = [...perks]; n[i] = v; setCfg('perks', n) }
  const addPerk     = ()     => setCfg('perks', [...perks, ''])
  const removePerk  = (i)    => setCfg('perks', perks.filter((_, idx) => idx !== i))

  const setHighlight = (i, key, v) => { const n = [...highlights]; n[i] = { ...(n[i] || {}), [key]: v }; setCfg('highlights', n) }
  const addHighlight    = () => setCfg('highlights', [...highlights, { value: '', label: '' }].slice(0, 4))
  const removeHighlight = (i) => setCfg('highlights', highlights.filter((_, idx) => idx !== i))

  const uploadHero = async (file) => {
    if (!file) return
    try { const url = await uploadImageToStorage(file, setUploading, 'hero'); setCfg('images', [{ url }]) }
    catch (err) { pushToast('Upload failed: ' + err.message, 'error') }
  }

  const generateCopy = async () => {
    if (!aiInput.trim()) return pushToast('Describe your list or audience first', 'error')
    setAiLoading(true)
    try {
      const r = await fetch('/api/claude', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          max_tokens: 600,
          system: `You are an elite email-marketing copywriter for a luxury real estate brand. Write copy for an email-list signup landing page. Return ONLY a raw JSON object — no markdown, no code fences. Keys: eyebrow (max 24 chars), cta_headline (max 70 chars), subheadline (max 200 chars), list_heading (max 40 chars), submit_label (max 24 chars), perks (array of exactly 3 short strings, max 60 chars each).`,
          messages: [{ role: 'user', content: `Write warm, premium, high-converting copy for this mailing list:\n\n${aiInput}` }],
        }),
      })
      const data = await r.json()
      if (data.error) { pushToast(data.error, 'error'); return }
      const match = (data.content?.[0]?.text || '').match(/\{[\s\S]*\}/)
      if (!match) { pushToast('AI returned an unexpected format — try again', 'error'); return }
      const copy = JSON.parse(match[0])
      ;['eyebrow', 'cta_headline', 'subheadline', 'list_heading', 'submit_label'].forEach(k => { if (copy[k]) setCfg(k, copy[k]) })
      if (Array.isArray(copy.perks)) setCfg('perks', copy.perks)
      setAiOpen(false)
      pushToast('AI copy applied — make it yours!')
    } catch (err) {
      pushToast('AI generation failed: ' + err.message, 'error')
    } finally { setAiLoading(false) }
  }

  return (
    <div style={{ border: '1px solid var(--gw-border)', borderRadius: 10, padding: 14, background: '#fafaf7' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Icon name="mail" size={14} />
        <div style={{ fontSize: 13, fontWeight: 700 }}>Mailing List Page Builder</div>
        <button type="button" onClick={() => setAiOpen(o => !o)}
                style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 12px', borderRadius: 20, cursor: 'pointer',
                         fontWeight: 700, background: aiOpen ? 'var(--gw-azure)' : '#eff6ff',
                         color: aiOpen ? '#fff' : 'var(--gw-azure)', border: '1px solid var(--gw-azure)' }}>
          ✨ {aiOpen ? 'Close AI' : 'Generate with AI'}
        </button>
      </div>

      {aiOpen && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#1d4ed8', marginBottom: 6 }}>
            Describe your list & audience — AI writes the headline, subheading, perks & button
          </div>
          <textarea className="input" rows={3} value={aiInput} onChange={e => setAiInput(e.target.value)}
                    placeholder="e.g. 'Weekly off-market multifamily deals + market notes for Sioux City investors. Positioning: exclusive, no fluff.'" />
          <button type="button" disabled={aiLoading} onClick={generateCopy}
                  style={{ marginTop: 8, padding: '6px 16px', fontSize: 12, fontWeight: 700,
                           background: aiLoading ? '#93c5fd' : 'var(--gw-azure)', color: '#fff',
                           border: 'none', borderRadius: 8, cursor: aiLoading ? 'default' : 'pointer' }}>
            {aiLoading ? 'Generating…' : '✨ Generate Copy'}
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {/* Theme + accent */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={fieldLabel}>Style</label>
            <div style={{ display: 'flex', border: '1px solid var(--gw-border)', borderRadius: 7, overflow: 'hidden', marginTop: 4 }}>
              {[['dark', 'Dark · Luxe'], ['light', 'Light · Ivory']].map(([val, lbl]) => {
                const sel = theme === val
                return (
                  <button key={val} type="button" onClick={() => setCfg('theme', val)}
                          style={{ flex: 1, padding: '7px 10px', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 700,
                                   background: sel ? 'var(--gw-azure)' : '#fff', color: sel ? '#fff' : 'var(--gw-mist)' }}>
                    {lbl}
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <label style={fieldLabel}>Accent color</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
              <input type="color" value={cfg.accent || '#c9a961'} onChange={e => setCfg('accent', e.target.value)}
                     style={{ width: 42, height: 36, border: '1px solid var(--gw-border)', borderRadius: 6, padding: 2, background: '#fff' }} />
              <input className="input" placeholder="#c9a961" value={cfg.accent || ''} onChange={e => setCfg('accent', e.target.value)} style={{ flex: 1 }} />
            </div>
          </div>
        </div>

        <div>
          <label style={fieldLabel}>Eyebrow (small kicker)</label>
          <input className="input" maxLength={40} value={cfg.eyebrow || ''} placeholder="The Gateway List"
                 onChange={e => setCfg('eyebrow', e.target.value)} />
        </div>

        {/* TOP CTA headline */}
        <div>
          <label style={fieldLabel}>Top headline (CTA)</label>
          <input className="input" maxLength={90} value={cfg.cta_headline || ''}
                 placeholder="Get Insider Updates Delivered Weekly"
                 onChange={e => setCfg('cta_headline', e.target.value)} />
        </div>

        <div>
          <label style={fieldLabel}>Subheadline</label>
          <textarea className="input" rows={2} maxLength={240} value={cfg.subheadline || ''}
                    placeholder="Off-market deals, market moves, and first looks — straight to your inbox. No noise, unsubscribe anytime."
                    onChange={e => setCfg('subheadline', e.target.value)} />
        </div>

        {/* EDITABLE form heading — replaces the old static "Questions/Notes" */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={fieldLabel}>Form heading</label>
            <input className="input" maxLength={50} value={cfg.list_heading || ''}
                   placeholder="Join My Exclusive Mailing List"
                   onChange={e => setCfg('list_heading', e.target.value)} />
          </div>
          <div>
            <label style={fieldLabel}>Form subheading</label>
            <input className="input" maxLength={80} value={cfg.list_subheading || ''}
                   placeholder="Enter your email — takes five seconds."
                   onChange={e => setCfg('list_subheading', e.target.value)} />
          </div>
        </div>

        {/* BOTTOM submit button + success message */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={fieldLabel}>Submit button text</label>
            <input className="input" maxLength={30} value={cfg.submit_label || ''}
                   placeholder="Subscribe Now"
                   onChange={e => setCfg('submit_label', e.target.value)} />
          </div>
          <div>
            <label style={fieldLabel}>Success message</label>
            <input className="input" maxLength={140} value={cfg.success_message || ''}
                   placeholder="You're on the list. Watch your inbox."
                   onChange={e => setCfg('success_message', e.target.value)} />
          </div>
        </div>

        {/* Fields to collect */}
        <div>
          <label style={fieldLabel}>Fields to collect</label>
          <div style={{ display: 'flex', gap: 16, marginTop: 6, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={cfg.collect_name !== false} onChange={e => setCfg('collect_name', e.target.checked)} />
              Name
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={cfg.collect_phone === true} onChange={e => setCfg('collect_phone', e.target.checked)} />
              Phone
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={cfg.collect_message !== false} onChange={e => setCfg('collect_message', e.target.checked)} />
              Message
            </label>
            <span style={{ fontSize: 12, color: 'var(--gw-mist)', alignSelf: 'center' }}>Email is always collected.</span>
          </div>
        </div>

        {/* Editable message-field heading — "what do you want from the list / to be contacted about" */}
        {cfg.collect_message !== false && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={fieldLabel}>Message field heading</label>
              <input className="input" maxLength={80} value={cfg.message_label || ''}
                     placeholder="What are you hoping to get? (optional)"
                     onChange={e => setCfg('message_label', e.target.value)} />
            </div>
            <div>
              <label style={fieldLabel}>Message field placeholder</label>
              <input className="input" maxLength={140} value={cfg.message_placeholder || ''}
                     placeholder="Tell us what you want us to reach out about…"
                     onChange={e => setCfg('message_placeholder', e.target.value)} />
            </div>
          </div>
        )}

        {/* Perks */}
        <div>
          <label style={fieldLabel}>What subscribers get (perks)</label>
          <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
            {perks.map((p, i) => (
              <div key={i} style={{ display: 'flex', gap: 6 }}>
                <input className="input" placeholder="e.g. First look at off-market listings" value={p}
                       onChange={e => setPerkAt(i, e.target.value)} style={{ flex: 1 }} />
                <button type="button" className="btn btn--ghost" onClick={() => removePerk(i)} style={{ padding: '6px 8px' }}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
            {perks.length < 6 && (
              <button type="button" className="btn btn--ghost" onClick={addPerk} style={{ fontSize: 12, alignSelf: 'flex-start' }}>
                <Icon name="plus" size={12} /> Add perk
              </button>
            )}
          </div>
        </div>

        {/* Optional credibility strip */}
        <div>
          <label style={fieldLabel}>Highlight stats (optional, up to 4)</label>
          <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
            {highlights.map((h, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 30px', gap: 6 }}>
                <input className="input" placeholder="Value (e.g. 2,400+)" value={h.value || ''}
                       onChange={e => setHighlight(i, 'value', e.target.value)} />
                <input className="input" placeholder="Label (e.g. Subscribers)" value={h.label || ''}
                       onChange={e => setHighlight(i, 'label', e.target.value)} />
                <button type="button" className="btn btn--ghost" onClick={() => removeHighlight(i)} style={{ padding: '6px 8px' }}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
            {highlights.length < 4 && (
              <button type="button" className="btn btn--ghost" onClick={addHighlight} style={{ fontSize: 12, alignSelf: 'flex-start' }}>
                <Icon name="plus" size={12} /> Add stat
              </button>
            )}
          </div>
        </div>

        {/* Optional hero image */}
        <div>
          <label style={fieldLabel}>Hero image (optional)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <div style={{ width: 60, height: 44, borderRadius: 6, border: '1px solid var(--gw-border)', overflow: 'hidden',
                          background: 'var(--gw-bone)', flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {heroUrl ? <img src={heroUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                       : <Icon name="building" size={14} style={{ opacity: 0.4 }} />}
            </div>
            <input className="input" placeholder="Paste image URL…" value={heroUrl}
                   onChange={e => setCfg('images', e.target.value ? [{ url: e.target.value }] : [])} style={{ flex: 1 }} />
            <label className="btn btn--secondary btn--sm" style={{ cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' }}>
              {uploading.hero ? 'Uploading…' : 'Upload'}
              <input type="file" accept="image/*" style={{ display: 'none' }}
                     onChange={e => { uploadHero(e.target.files?.[0]); e.target.value = '' }} />
            </label>
            {heroUrl && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCfg('images', [])}>Remove</button>
            )}
          </div>
        </div>

        <OmUploadField cfg={cfg} setCfg={setCfg}
                       label="Gated PDF download (optional)"
                       hint="A deal package, market report or OM. It sits above the signup form and unlocks only after the visitor gives their name, phone and email — those land as leads, separately from the email list." />

        <div>
          <label style={fieldLabel}>Consent / fine print</label>
          <input className="input" maxLength={200} value={cfg.consent_text || ''}
                 placeholder="By subscribing you agree to receive occasional emails. We never sell your data."
                 onChange={e => setCfg('consent_text', e.target.value)} />
        </div>
      </div>
    </div>
  )
}

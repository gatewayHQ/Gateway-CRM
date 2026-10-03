import React, { useState } from 'react'
import { Icon, pushToast } from '../../../components/UI.jsx'
import { fieldLabel, normImg, uploadImageToStorage } from './imageUpload.js'
import { ImageRow } from './ImageRow.jsx'
import { OmUploadField } from './OmUploadField.jsx'

// ─── CollageBuilder — multifamily + valuation landing config ─────────────────

export function CollageBuilder({ cfg, setCfg, variant = 'multifamily' }) {
  const [aiOpen, setAiOpen]       = useState(false)
  const [aiInput, setAiInput]     = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiTone, setAiTone]       = useState('professional')
  const [uploading, setUploading] = useState({})

  const images     = Array.isArray(cfg.images)     ? cfg.images.map(normImg) : []
  const highlights = Array.isArray(cfg.highlights) ? cfg.highlights           : []

  const setImageField = (i, field, val) => {
    const next = images.map((img, idx) => idx === i ? { ...img, [field]: val } : img)
    setCfg('images', next)
  }
  const addImage    = () => setCfg('images', [...images, { url:'', units:'', price:'', caption:'' }].slice(0, 6))
  const removeImage = (i) => setCfg('images', images.filter((_, idx) => idx !== i))

  const uploadFile = async (i, file) => {
    if (!file) return
    try {
      const url = await uploadImageToStorage(file, setUploading, i)
      setImageField(i, 'url', url)
    } catch (err) { pushToast('Upload failed: ' + err.message, 'error') }
  }

  const setHighlight = (i, key, v) => {
    const next = [...highlights]; next[i] = { ...(next[i] || {}), [key]: v }
    setCfg('highlights', next)
  }
  const addHighlight    = () => setCfg('highlights', [...highlights, { label: '', value: '' }].slice(0, 4))
  const removeHighlight = (i) => setCfg('highlights', highlights.filter((_, idx) => idx !== i))

  const generateCopy = async (tone) => {
    if (!aiInput.trim()) return pushToast('Describe the property or campaign first', 'error')
    setAiLoading(true)
    try {
      const r = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          max_tokens: 600,
          system: `You are an elite real estate marketing copywriter. Write landing page copy for a ${variant === 'valuation' ? 'home valuation' : 'multifamily property valuation'} capture page. Return ONLY a raw JSON object — no markdown, no code fences. Keys: headline (max 90 chars), subheadline (max 260 chars), highlights (array of 3 objects each with "label" and "value"), cta_text (max 30 chars).`,
          messages: [{ role:'user', content:`Write ${tone === 'punchy' ? 'punchy, bold, and urgent' : tone === 'conversational' ? 'warm, conversational, and approachable' : 'professional, authoritative, and credible'} copy:\n\n${aiInput}` }],
        }),
      })
      const data = await r.json()
      if (data.error) { pushToast(data.error, 'error'); return }
      const text  = data.content?.[0]?.text || ''
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) { pushToast('AI returned unexpected format — try again', 'error'); return }
      const copy = JSON.parse(match[0])
      if (copy.headline)    setCfg('headline',    copy.headline)
      if (copy.subheadline) setCfg('subheadline', copy.subheadline)
      if (copy.highlights)  setCfg('highlights',  copy.highlights)
      if (copy.cta_text)    setCfg('cta_text',    copy.cta_text)
      setAiOpen(false)
      pushToast('AI copy applied — review and make it yours!')
    } catch (err) {
      pushToast('AI generation failed: ' + err.message, 'error')
    } finally {
      setAiLoading(false)
    }
  }

  const isVal    = variant === 'valuation'
  const hlHint   = isVal
    ? '"120+ homeowners served", "18 days avg close", "12 neighborhoods"'
    : '"$240M+ closed", "38 days avg sale", "14 sub-markets"'

  return (
    <div style={{ border:'1px solid var(--gw-border)', borderRadius:10, padding:14, background:'#fafaf7' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom: aiOpen ? 8 : 10 }}>
        <Icon name="sparkles" size={14} />
        <div style={{ fontSize:13, fontWeight:700 }}>
          {isVal ? 'Home Valuation Page Builder' : 'Multifamily Landing Page Builder'}
        </div>
        <button type="button" onClick={() => setAiOpen(o => !o)}
                style={{ marginLeft:'auto', fontSize:11, padding:'4px 12px', borderRadius:20, cursor:'pointer',
                         fontWeight:700, background: aiOpen ? 'var(--gw-azure)' : '#eff6ff',
                         color: aiOpen ? '#fff' : 'var(--gw-azure)', border:'1px solid var(--gw-azure)' }}>
          ✨ {aiOpen ? 'Close AI' : 'Generate with AI'}
        </button>
      </div>

      {aiOpen && (
        <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:8, padding:12, marginBottom:10 }}>
          <div style={{ fontSize:12, fontWeight:700, color:'#1d4ed8', marginBottom:6 }}>
            Describe the property or campaign — AI writes headline, subheadline, stats, and CTA
          </div>
          <textarea className="input" rows={3} value={aiInput} onChange={e => setAiInput(e.target.value)}
                    placeholder={isVal
                      ? "e.g. 'Just sold a home in East Oakland. Targeting neighboring homeowners. Market moving fast — under 3 weeks.'"
                      : "e.g. 'Just sold 24-unit in Oakland near BART. Targeting apartment owners nearby. Cap rates at 5.2%.'"}  />
          <div style={{ display:'flex', gap:6, alignItems:'center', marginTop:8, flexWrap:'wrap' }}>
            <span style={{ fontSize:11, color:'var(--gw-mist)', fontWeight:700 }}>Tone:</span>
            {['professional','punchy','conversational'].map(t => (
              <button key={t} type="button" onClick={() => setAiTone(t)}
                      style={{ fontSize:11, padding:'3px 10px', borderRadius:12, cursor:'pointer', fontWeight:600,
                               background: aiTone === t ? 'var(--gw-azure)' : '#fff',
                               color: aiTone === t ? '#fff' : 'var(--gw-ink)',
                               border:`1px solid ${aiTone === t ? 'var(--gw-azure)' : 'var(--gw-border)'}` }}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
            <button type="button" disabled={aiLoading} onClick={() => generateCopy(aiTone)}
                    style={{ marginLeft:'auto', padding:'6px 16px', fontSize:12, fontWeight:700,
                             background: aiLoading ? '#93c5fd' : 'var(--gw-azure)', color:'#fff',
                             border:'none', borderRadius:8, cursor: aiLoading ? 'default' : 'pointer' }}>
              {aiLoading ? 'Generating…' : '✨ Generate Copy'}
            </button>
          </div>
          {(cfg.headline || cfg.subheadline) && !aiLoading && (
            <div style={{ display:'flex', gap:6, alignItems:'center', marginTop:8, borderTop:'1px solid #bfdbfe', paddingTop:8, flexWrap:'wrap' }}>
              <span style={{ fontSize:11, color:'#3b82f6', fontWeight:600 }}>Refine:</span>
              {[['Make it punchier','punchy'],['More professional','professional'],['Conversational','conversational']].map(([lbl, t]) => (
                <button key={t} type="button" onClick={() => generateCopy(t)}
                        style={{ fontSize:11, padding:'3px 10px', border:'1px solid #bfdbfe', borderRadius:12, background:'#fff', cursor:'pointer', color:'#1d4ed8' }}>
                  {lbl}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display:'grid', gap:10 }}>
        <div>
          <label style={fieldLabel}>Headline</label>
          <input className="input" maxLength={140} value={cfg.headline || ''}
                 placeholder={isVal ? "What's your home worth in today's market?" : "What's your multifamily really worth?"}
                 onChange={e => setCfg('headline', e.target.value)} />
        </div>
        <div>
          <label style={fieldLabel}>Subheadline</label>
          <textarea className="input" rows={2} maxLength={300} value={cfg.subheadline || ''}
                    placeholder={isVal
                      ? "Get a private, no-obligation valuation from a licensed broker who knows your neighborhood."
                      : "Get a cap-rate-driven valuation from a broker who actually closes deals in your submarket."}
                    onChange={e => setCfg('subheadline', e.target.value)} />
        </div>

        <div>
          <label style={fieldLabel}>Photos (up to 6) — upload from computer or paste URL</label>
          <div style={{ display:'grid', gap:8, marginTop:4 }}>
            {images.map((img, i) => (
              <ImageRow key={i} img={img} index={i} uploading={uploading}
                        onField={(f, v) => setImageField(i, f, v)}
                        onUpload={file => uploadFile(i, file)}
                        onRemove={() => removeImage(i)}
                        unitsLabel="Units (e.g. 24 units)"
                        priceLabel="Sale price / note (e.g. $4.2M)" />
            ))}
            {images.length < 6 && (
              <button type="button" className="btn btn--ghost" onClick={addImage} style={{ fontSize:12, alignSelf:'flex-start' }}>
                <Icon name="plus" size={12} /> Add photo
              </button>
            )}
          </div>
          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6 }}>
            Units and sale price appear as a caption under each photo on the live page.
          </div>
        </div>

        <div>
          <label style={fieldLabel}>Highlight stats (up to 4) — your credibility strip</label>
          {highlights.length === 0 && (
            <div style={{ fontSize:11, color:'var(--gw-mist)', margin:'4px 0 6px' }}>
              Try: {hlHint}
            </div>
          )}
          <div style={{ display:'grid', gap:6, marginTop:4 }}>
            {highlights.map((h, i) => (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'140px 1fr 30px', gap:6 }}>
                <input className="input" placeholder="Value (e.g. $240M+)" value={h.value || ''}
                       onChange={e => setHighlight(i, 'value', e.target.value)} />
                <input className="input" placeholder="Label (e.g. Closed in submarket)" value={h.label || ''}
                       onChange={e => setHighlight(i, 'label', e.target.value)} />
                <button type="button" className="btn btn--ghost" onClick={() => removeHighlight(i)} style={{ padding:'6px 8px' }}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
            {highlights.length < 4 && (
              <button type="button" className="btn btn--ghost" onClick={addHighlight} style={{ fontSize:12, alignSelf:'flex-start' }}>
                <Icon name="plus" size={12} /> Add stat
              </button>
            )}
          </div>
        </div>

        <OmUploadField cfg={cfg} setCfg={setCfg}
                       label={isVal ? 'Gated PDF download (optional)' : 'Offering Memorandum (PDF, optional)'}
                       hint={isVal
                         ? 'Attach a market report or seller guide. It unlocks only after the visitor gives their name, phone and email — each unlock is a lead.'
                         : 'Attach the deal package. It unlocks only after the visitor gives their name, phone and email — an OM reader is your warmest lead.'} />

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
          <div>
            <label style={fieldLabel}>CTA button text</label>
            <input className="input" maxLength={40} placeholder="Get my free valuation" value={cfg.cta_text || ''}
                   onChange={e => setCfg('cta_text', e.target.value)} />
          </div>
          <div>
            <label style={fieldLabel}>Accent color</label>
            <div style={{ display:'flex', gap:6, alignItems:'center' }}>
              <input type="color" value={cfg.accent || '#c9a961'} onChange={e => setCfg('accent', e.target.value)}
                     style={{ width:42, height:36, border:'1px solid var(--gw-border)', borderRadius:6, padding:2, background:'#fff' }} />
              <input className="input" placeholder="#c9a961" value={cfg.accent || ''} onChange={e => setCfg('accent', e.target.value)} style={{ flex:1 }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

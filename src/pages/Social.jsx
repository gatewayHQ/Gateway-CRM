import React, { useState, useCallback, useMemo } from 'react'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase.js'
import { Icon, pushToast } from '../components/UI.jsx'

async function loadUserKey() {
  const { data: { user } } = await supabase.auth.getUser()
  return user?.user_metadata?.anthropic_key || localStorage.getItem('gw_anthropic_key') || ''
}

// ─── Post type taxonomy ────────────────────────────────────────────────────────
// "property" types: pull from CRM, Canva templates exist
// "content"  types: structured guided form, generate branded card for IG/FB
const PROPERTY_TYPES = new Set(['listing', 'sold', 'openhouse', 'price_drop', 'just_leased'])
const CONTENT_TYPES  = new Set(['market', 'tip', 'neighborhood', 'testimonial', 'spotlight'])

const POST_TYPES = [
  // ── Property posts ──
  { id: 'listing',      group: 'property', label: '🏠 New Listing',         desc: 'Announce a new property to market' },
  { id: 'sold',         group: 'property', label: '🎉 Just Sold',            desc: 'Celebrate a closed transaction' },
  { id: 'openhouse',    group: 'property', label: '🚪 Open House',           desc: 'Invite followers to an upcoming showing' },
  { id: 'price_drop',   group: 'property', label: '🏷️ Price Reduced',        desc: 'Alert followers to a price improvement' },
  { id: 'just_leased',  group: 'property', label: '🔑 Just Leased',          desc: 'Announce a lease signing' },
  // ── Content posts ──
  { id: 'market',       group: 'content',  label: '📊 Market Update',        desc: 'Share local market stats & your expert take' },
  { id: 'tip',          group: 'content',  label: '💡 Real Estate Tip',      desc: 'Educational content for buyers/sellers' },
  { id: 'neighborhood', group: 'content',  label: '🏘️ Neighborhood Feature',  desc: 'Spotlight a local area or community' },
  { id: 'testimonial',  group: 'content',  label: '⭐ Client Story',          desc: 'Share a client success or testimonial' },
  { id: 'spotlight',    group: 'content',  label: '👤 Agent Spotlight',      desc: 'Introduce a team member' },
]

const PLATFORMS = ['Instagram', 'Facebook', 'LinkedIn']

// ─── Platform guidance ─────────────────────────────────────────────────────────
// Instagram: hook in first 125 chars (before "...more"), body 150–240 chars,
//            hashtags as a separate paragraph (5–10). Total under ~600 chars.
const PLATFORM_NOTES = {
  Instagram: 'Hook in the FIRST LINE (≤ 125 chars before "...more"). Body: 150–240 chars total. Hashtags: separate block of 7–10 at the end. No essay — punchy and visual.',
  Facebook:  'Conversational, community-focused. 2–3 short sentences + call to action. 150–300 chars. 3–5 hashtags.',
  LinkedIn:  'Professional, educational tone. 150–200 words max. 2–3 hashtags only. No fluff.',
}

// ─── Property post field config ────────────────────────────────────────────────
const PROPERTY_FIELD_CONFIG = {
  listing:     { address: 'Property Address', price: 'List Price',   features: 'Key Features / Highlights', beds: true, baths: true },
  sold:        { address: 'Property Address', price: 'Sale Price',   features: 'Notable Details' },
  openhouse:   { address: 'Property Address', price: 'Asking Price', features: 'Date & Time (e.g. Sat Nov 9 · 1–4 PM)', beds: true, baths: true },
  price_drop:  { address: 'Property Address', price: 'New Price',    features: 'Previous Price & Key Selling Points' },
  just_leased: { address: 'Property Address', price: 'Monthly Rent', features: 'Property Highlights' },
}

// ─── Content post structured field config ─────────────────────────────────────
const CONTENT_FIELD_CONFIG = {
  market: [
    { key: 'area',    label: 'Market / Neighborhood',  type: 'text',     placeholder: 'e.g. South Austin, TX' },
    { key: 'period',  label: 'Time Period',             type: 'text',     placeholder: 'e.g. April 2026 / Q1 2026' },
    { key: 'stat1',   label: 'Key Stat #1',             type: 'text',     placeholder: 'e.g. Avg sale price: $485k (↑ 8% YoY)' },
    { key: 'stat2',   label: 'Key Stat #2',             type: 'text',     placeholder: 'e.g. Avg days on market: 22 (↓ from 31)' },
    { key: 'stat3',   label: 'Key Stat #3 (optional)',  type: 'text',     placeholder: 'e.g. Active listings: 142 (↓ 15%)' },
    { key: 'insight', label: 'Your Expert Take',        type: 'textarea', placeholder: 'e.g. Inventory is tightening — buyers who hesitated last month are already losing out.' },
  ],
  tip: [
    { key: 'topic',    label: 'Tip Topic / Title',   type: 'text',     placeholder: 'e.g. How to Win a Bidding War' },
    { key: 'audience', label: 'Who Is This For?',    type: 'select',   options: ['Buyers', 'Sellers', 'Investors', 'First-Time Buyers', 'Renters', 'Anyone'] },
    { key: 'point1',   label: 'Point #1',            type: 'text',     placeholder: 'e.g. Get pre-approved before you look' },
    { key: 'point2',   label: 'Point #2',            type: 'text',     placeholder: 'e.g. Be flexible on closing date' },
    { key: 'point3',   label: 'Point #3 (optional)', type: 'text',     placeholder: 'e.g. Escalation clauses win competitive markets' },
    { key: 'cta',      label: 'Call to Action',      type: 'text',     placeholder: 'e.g. DM me to talk strategy' },
  ],
  neighborhood: [
    { key: 'name',  label: 'Neighborhood Name',     type: 'text',     placeholder: 'e.g. South Congress, Austin' },
    { key: 'vibe',  label: 'The Vibe / Feel',       type: 'text',     placeholder: 'e.g. Artsy, walkable, family-friendly' },
    { key: 'spots', label: 'Must-Know Spots',       type: 'text',     placeholder: 'e.g. Uchi, Barton Springs, Farmers Market' },
    { key: 'stats', label: 'Real Estate Snapshot',  type: 'text',     placeholder: 'e.g. Median $620k · 3 listings under $500k' },
    { key: 'why',   label: 'Why Live / Invest Here?', type: 'textarea', placeholder: 'e.g. Top-rated schools, 10 min to downtown, new mixed-use development incoming' },
  ],
  testimonial: [
    { key: 'name',      label: 'Client First Name (optional)', type: 'text',     placeholder: 'e.g. Sarah' },
    { key: 'situation', label: 'Their Starting Point',         type: 'text',     placeholder: 'e.g. First-time buyer, nervous about the process' },
    { key: 'result',    label: 'What They Achieved',           type: 'text',     placeholder: 'e.g. Closed $15k under asking, 3 weeks start to finish' },
    { key: 'quote',     label: 'Their Quote (optional)',       type: 'textarea', placeholder: 'e.g. "We never felt like just another transaction"' },
    { key: 'cta',       label: 'Call to Action',              type: 'text',     placeholder: 'e.g. Ready to write your story? DM me.' },
  ],
  spotlight: [
    { key: 'name',      label: 'Agent Name',          type: 'text', placeholder: 'e.g. Jamie Torres' },
    { key: 'title',     label: 'Title / Role',         type: 'text', placeholder: 'e.g. Senior Advisor · Commercial' },
    { key: 'specialty', label: 'Specialty / Niche',    type: 'text', placeholder: 'e.g. Multifamily, 1031 exchanges' },
    { key: 'years',     label: 'Years of Experience',  type: 'text', placeholder: 'e.g. 8 years' },
    { key: 'funfact',   label: 'Fun Fact / Personal',  type: 'text', placeholder: 'e.g. Weekend hiker, 2 rescue dogs' },
    { key: 'contact',   label: 'How to Reach Them',    type: 'text', placeholder: 'e.g. @jamie on IG or DM the team' },
  ],
}

// ─── Post card visual styles ───────────────────────────────────────────────────
const CARD_STYLES = {
  market:       { bg: 'linear-gradient(135deg, #0f1d3b 0%, #1a3060 100%)', text: '#e8eef8', accent: '#7aa7f0', border: 'rgba(122,167,240,0.3)' },
  tip:          { bg: 'linear-gradient(135deg, #3d2400 0%, #7a4800 100%)', text: '#fef3e2', accent: '#f5b942', border: 'rgba(245,185,66,0.3)' },
  neighborhood: { bg: 'linear-gradient(135deg, #0d2b1a 0%, #1a4d2e 100%)', text: '#e2f5ea', accent: '#5bce8a', border: 'rgba(91,206,138,0.3)' },
  testimonial:  { bg: 'linear-gradient(135deg, #2d0a1a 0%, #5a1530 100%)', text: '#fde8ef', accent: '#f07ab0', border: 'rgba(240,122,176,0.3)' },
  spotlight:    { bg: 'linear-gradient(135deg, #1a0a35 0%, #3a1570 100%)', text: '#ede8fe', accent: '#a78bfa', border: 'rgba(167,139,250,0.3)' },
}

// ─── Prompts ───────────────────────────────────────────────────────────────────
function igLimit(platform) {
  return platform === 'Instagram'
    ? 'CRITICAL for Instagram: body text must be 150–240 characters MAXIMUM (not counting hashtags). Hook = first line, ≤ 125 chars. Then 1 line break. Then hashtags on a new paragraph (7–10 tags).'
    : platform === 'Facebook'
    ? 'Facebook: 2–3 punchy sentences, 150–300 chars total, then 3–5 hashtags.'
    : 'LinkedIn: professional, 150–200 words, 2–3 hashtags at end.'
}

const POST_PROMPTS = {
  // Property types
  listing: (d) => `Write a social media post announcing a new real estate listing.
Address: ${d.address || ''}
Price: ${d.price || ''}
Beds/Baths: ${d.beds || ''} bed / ${d.baths || ''} bath
Key features: ${d.features || ''}
Platform: ${d.platform}
${igLimit(d.platform)}`,

  sold: (d) => `Write a "Just Sold" social media post.
Property: ${d.address || ''}
Sale Price: ${d.price || ''}
Details: ${d.features || ''}
Platform: ${d.platform}
Warm, celebratory, professional. Thank the client without naming them.
${igLimit(d.platform)}`,

  openhouse: (d) => `Write an open house invitation social media post.
Property: ${d.address || ''}
Price: ${d.price || ''}
Beds/Baths: ${d.beds || ''} bed / ${d.baths || ''} bath
Date/Time: ${d.features || ''}
Platform: ${d.platform}
Inviting, creates urgency. Include RSVP or visit call-to-action.
${igLimit(d.platform)}`,

  price_drop: (d) => `Write a "Price Reduced" social media post.
Property: ${d.address || ''}
New Price: ${d.price || ''}
Context: ${d.features || ''}
Platform: ${d.platform}
Emphasise opportunity and urgency — this won't last.
${igLimit(d.platform)}`,

  just_leased: (d) => `Write a "Just Leased" social media post.
Property: ${d.address || ''}
Monthly Rent: ${d.price || ''}
Highlights: ${d.features || ''}
Platform: ${d.platform}
Celebratory. Mention availability for similar properties.
${igLimit(d.platform)}`,

  // Content types — use structured d.fields object
  market: (d) => `Write a real estate market update social media post.
Market/Neighborhood: ${d.fields.area || ''}
Period: ${d.fields.period || ''}
Key Stats:
  - ${d.fields.stat1 || ''}${d.fields.stat2 ? '\n  - ' + d.fields.stat2 : ''}${d.fields.stat3 ? '\n  - ' + d.fields.stat3 : ''}
Expert take: ${d.fields.insight || ''}
Platform: ${d.platform}
Position the agent as the trusted local expert. End with a question to drive engagement.
${igLimit(d.platform)}`,

  tip: (d) => `Write a real estate tip social media post.
Topic: ${d.fields.topic || ''}
Audience: ${d.fields.audience || 'buyers and sellers'}
Key points:
  1. ${d.fields.point1 || ''}${d.fields.point2 ? '\n  2. ' + d.fields.point2 : ''}${d.fields.point3 ? '\n  3. ' + d.fields.point3 : ''}
Call to action: ${d.fields.cta || ''}
Platform: ${d.platform}
Helpful, clear, authoritative without being preachy.
${igLimit(d.platform)}`,

  neighborhood: (d) => `Write a neighborhood feature social media post.
Neighborhood: ${d.fields.name || ''}
Vibe: ${d.fields.vibe || ''}
Must-know spots: ${d.fields.spots || ''}
Real estate snapshot: ${d.fields.stats || ''}
Why live/invest here: ${d.fields.why || ''}
Platform: ${d.platform}
Paint a vivid lifestyle picture. Tie it back to the real estate opportunity.
${igLimit(d.platform)}`,

  testimonial: (d) => `Write a client story social media post.
Client first name: ${d.fields.name || 'A recent client'}
Their starting situation: ${d.fields.situation || ''}
What they achieved: ${d.fields.result || ''}
Their quote: ${d.fields.quote || 'none provided'}
Call to action: ${d.fields.cta || ''}
Platform: ${d.platform}
Warm, human, authentic. Do NOT fabricate beyond what is provided. Soft CTA for future clients.
${igLimit(d.platform)}`,

  spotlight: (d) => `Write an agent spotlight social media post.
Agent: ${d.fields.name || ''}
Title/Role: ${d.fields.title || ''}
Specialty: ${d.fields.specialty || ''}
Experience: ${d.fields.years || ''}
Fun fact: ${d.fields.funfact || ''}
How to reach: ${d.fields.contact || ''}
Platform: ${d.platform}
Personal, warm, make this agent memorable.
${igLimit(d.platform)}`,
}

// ─── CRM property → form fields ───────────────────────────────────────────────
function propertyToFields(p) {
  if (!p) return { address: '', price: '', beds: '', baths: '', features: '' }
  const d = p.details || {}
  const addr = [p.address, p.city, p.state].filter(Boolean).join(', ')
  const priceStr = p.list_price ? `$${Number(p.list_price).toLocaleString()}` : ''
  const parts = []
  if (p.sqft)         parts.push(`${Number(p.sqft).toLocaleString()} sqft`)
  if (d.year_built)   parts.push(`Built ${d.year_built}`)
  if (p.garage > 0)   parts.push(`${p.garage}-car garage`)
  if (d.total_units)  parts.push(`${d.total_units} units`)
  if (d.unit_mix)     parts.push(d.unit_mix)
  if (p.notes)        parts.push(p.notes.slice(0, 120))
  return { address: addr, price: priceStr, beds: String(p.beds || ''), baths: String(p.baths || ''), features: parts.join(' · ') }
}

// ─── Post card export (screenshot-able) ───────────────────────────────────────
function exportCard(postTypeId, caption, agentName) {
  const cs    = CARD_STYLES[postTypeId] || CARD_STYLES.market
  const label = POST_TYPES.find(pt => pt.id === postTypeId)?.label || ''
  const body  = caption.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')
  const w = window.open('', '_blank', 'width=640,height=700')
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1a1a1a; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .wrap { width: 540px; }
  .card { width: 540px; min-height: 540px; background: ${cs.bg}; padding: 44px 40px 36px; display: flex; flex-direction: column; position: relative; }
  .badge { font-size: 11px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: ${cs.accent}; margin-bottom: 24px; }
  .body { font-size: 15px; line-height: 1.65; color: ${cs.text}; flex: 1; white-space: pre-wrap; word-break: break-word; }
  .divider { height: 1px; background: ${cs.border}; margin: 28px 0 20px; }
  .footer { display: flex; justify-content: space-between; align-items: center; }
  .agent { font-size: 12px; font-weight: 700; color: ${cs.accent}; }
  .brand { font-size: 10px; color: ${cs.border}; letter-spacing: 0.08em; text-transform: uppercase; }
  .hint { text-align: center; color: #666; font-size: 12px; margin-top: 14px; }
  @media print { body { background: white; } .hint { display: none; } }
</style></head><body>
  <div class="wrap">
    <div class="card">
      <div class="badge">${label}</div>
      <div class="body">${body}</div>
      <div class="divider"></div>
      <div class="footer">
        <div class="agent">${(agentName || 'Gateway Real Estate Advisors').replace(/&/g,'&amp;')}</div>
        <div class="brand">Gateway Real Estate Advisors</div>
      </div>
    </div>
    <div class="hint">Screenshot or ⌘P / Ctrl+P to save as PDF &nbsp;·&nbsp; Close when done</div>
  </div>
</body></html>`)
  w.document.close()
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function SocialPage({ db, activeAgent }) {
  const [postType,       setPostType]       = useState('listing')
  const [platform,       setPlatform]       = useState('Instagram')
  // Property post state
  const [selectedPropId, setSelectedPropId] = useState('')
  const [address,        setAddress]        = useState('')
  const [price,          setPrice]          = useState('')
  const [beds,           setBeds]           = useState('')
  const [baths,          setBaths]          = useState('')
  const [features,       setFeatures]       = useState('')
  // Content post state
  const [contentData,    setContentData]    = useState({})   // {[fieldKey]: value}
  // Output
  const [caption,        setCaption]        = useState('')
  const [generating,     setGenerating]     = useState(false)
  const [copied,         setCopied]         = useState(false)

  const toolkitUrl = localStorage.getItem('gw_toolkit_url') || ''

  const isProperty = PROPERTY_TYPES.has(postType)
  const isContent  = CONTENT_TYPES.has(postType)

  // ── CRM properties available for picker ──
  const crmProperties = useMemo(() => {
    if (!isProperty) return []
    const props = db?.properties || []
    if (postType === 'sold')        return props.filter(p => p.status === 'sold')
    if (postType === 'just_leased') return props.filter(p => p.status === 'leased')
    return props.filter(p => p.status === 'active' || p.status === 'pending')
  }, [db?.properties, postType, isProperty])

  const setContentField = (key, val) => setContentData(prev => ({ ...prev, [key]: val }))

  const handlePostTypeChange = (id) => {
    setPostType(id)
    setCaption('')
    setSelectedPropId('')
    setAddress(''); setPrice(''); setBeds(''); setBaths(''); setFeatures('')
    setContentData({})
  }

  const handlePropSelect = useCallback((propId) => {
    setSelectedPropId(propId)
    setCaption('')
    if (!propId) return
    const prop = (db?.properties || []).find(p => p.id === propId)
    const f = propertyToFields(prop)
    setAddress(f.address); setPrice(f.price); setBeds(f.beds); setBaths(f.baths); setFeatures(f.features)
  }, [db?.properties])

  // ── Generate ──
  const generate = useCallback(async () => {
    const apiKey = await loadUserKey()
    if (!apiKey) { pushToast('Add your Anthropic API key in Settings → AI Configuration', 'error'); return }
    setGenerating(true)
    setCaption('')
    try {
      const promptFn = POST_PROMPTS[postType]
      const prompt = promptFn(isProperty
        ? { address, price, beds, baths, features, platform }
        : { fields: contentData, platform }
      )
      const agentName = activeAgent?.name || 'a Gateway Real Estate advisor'
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 60000 })
      const stream = client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: `You are a social media content writer for Gateway Real Estate Advisors. The agent posting is ${agentName}. Write engaging, on-brand real estate posts. Professional yet personable. Use emojis naturally. Do NOT wrap the post in quotes. Return ONLY the post text — nothing else, no preamble.`,
        messages: [{ role: 'user', content: prompt }],
      })
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          setCaption(prev => prev + chunk.delta.text)
        }
      }
      pushToast('Caption generated')
    } catch (err) {
      pushToast('Generation failed: ' + err.message, 'error')
    }
    setGenerating(false)
  }, [postType, isProperty, platform, address, price, beds, baths, features, contentData, activeAgent])

  const copyCaption = () => {
    navigator.clipboard.writeText(caption)
    setCopied(true)
    setTimeout(() => setCopied(false), 2200)
    pushToast('Caption copied to clipboard')
  }

  const contentFields = CONTENT_FIELD_CONFIG[postType] || []
  const pf = isProperty ? (PROPERTY_FIELD_CONFIG[postType] || {}) : {}
  const cardStyle = CARD_STYLES[postType]
  const postTypeMeta = POST_TYPES.find(pt => pt.id === postType)

  // ── Char count colour for Instagram ──
  const charCount = caption.length
  const bodyOnlyCount = platform === 'Instagram' ? caption.replace(/#\S+/g, '').trim().length : charCount
  const igOverLimit = platform === 'Instagram' && bodyOnlyCount > 240

  return (
    <div className="page-content" style={{ maxWidth: 960 }}>
      <div className="page-header">
        <div>
          <div className="page-title">Social Media</div>
          <div className="page-sub">AI Caption Generator &amp; Toolkit Launcher</div>
        </div>
        {toolkitUrl && (
          <a href={toolkitUrl} target="_blank" rel="noopener noreferrer" className="btn btn--secondary">
            <Icon name="om" size={14} /> Open Gateway Toolkit
          </a>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
        {/* ─────────── LEFT: inputs ─────────── */}
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 16 }}>Post Details</div>

          {/* Post type — two groups */}
          <div className="form-group">
            <label className="form-label">Post Type</label>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--gw-mist)', marginBottom: 6 }}>
              Property Posts · pull from CRM or enter manually
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginBottom: 10 }}>
              {POST_TYPES.filter(pt => pt.group === 'property').map(pt => (
                <label key={pt.id} title={pt.desc}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
                    border: `1px solid ${postType === pt.id ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                    borderRadius: 'var(--radius)', cursor: 'pointer',
                    background: postType === pt.id ? 'var(--gw-sky)' : '#fff',
                    transition: 'all 120ms', fontSize: 12 }}>
                  <input type="radio" name="postType" value={pt.id} checked={postType === pt.id}
                    onChange={() => handlePostTypeChange(pt.id)} style={{ display: 'none' }} />
                  {pt.label}
                </label>
              ))}
            </div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--gw-mist)', marginBottom: 6 }}>
              Content Posts · guided form → branded card
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              {POST_TYPES.filter(pt => pt.group === 'content').map(pt => (
                <label key={pt.id} title={pt.desc}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
                    border: `1px solid ${postType === pt.id ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                    borderRadius: 'var(--radius)', cursor: 'pointer',
                    background: postType === pt.id ? 'var(--gw-sky)' : '#fff',
                    transition: 'all 120ms', fontSize: 12 }}>
                  <input type="radio" name="postType" value={pt.id} checked={postType === pt.id}
                    onChange={() => handlePostTypeChange(pt.id)} style={{ display: 'none' }} />
                  {pt.label}
                </label>
              ))}
            </div>
          </div>

          {/* Platform */}
          <div className="form-group">
            <label className="form-label">Platform</label>
            <div style={{ display: 'flex', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              {PLATFORMS.map(p => (
                <button key={p} type="button" onClick={() => { setPlatform(p); setCaption('') }}
                  style={{ flex: 1, padding: '7px 0', border: 'none', cursor: 'pointer',
                    fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, transition: 'all 120ms',
                    background: platform === p ? 'var(--gw-slate)' : '#fff',
                    color:      platform === p ? '#fff' : 'var(--gw-mist)' }}>
                  {p}
                </button>
              ))}
            </div>
            {platform === 'Instagram' && (
              <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 5, lineHeight: 1.5 }}>
                Hook ≤ 125 chars · Body 150–240 chars · Hashtags separate
              </div>
            )}
          </div>

          {/* ── Property post fields ── */}
          {isProperty && (
            <>
              {crmProperties.length > 0 && (
                <div className="form-group">
                  <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="properties" size={12} /> Pull from CRM Property
                  </label>
                  <select className="form-control filter-select" value={selectedPropId}
                    onChange={e => handlePropSelect(e.target.value)}>
                    <option value="">— Enter details manually —</option>
                    {crmProperties.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.address}{p.city ? `, ${p.city}` : ''}{p.price ? ` · $${Number(p.price).toLocaleString()}` : ''}
                      </option>
                    ))}
                  </select>
                  {selectedPropId && (
                    <div style={{ fontSize: 11, color: 'var(--gw-azure)', marginTop: 4 }}>
                      ✓ Pre-filled from CRM — edit any field to customise
                    </div>
                  )}
                </div>
              )}
              {pf.address && (
                <div className="form-group">
                  <label className="form-label">{pf.address}</label>
                  <input className="form-control" value={address}
                    onChange={e => { setAddress(e.target.value); setSelectedPropId('') }} placeholder={pf.address} />
                </div>
              )}
              {pf.price && (
                <div className="form-group">
                  <label className="form-label">{pf.price}</label>
                  <input className="form-control" value={price}
                    onChange={e => { setPrice(e.target.value); setSelectedPropId('') }} placeholder="e.g. $425,000" />
                </div>
              )}
              {pf.beds && (
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Beds</label>
                    <input className="form-control" type="number" value={beds} onChange={e => setBeds(e.target.value)} placeholder="3" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Baths</label>
                    <input className="form-control" type="number" value={baths} onChange={e => setBaths(e.target.value)} placeholder="2" />
                  </div>
                </div>
              )}
              {pf.features && (
                <div className="form-group">
                  <label className="form-label">{pf.features}</label>
                  <textarea className="form-control form-control--textarea" style={{ minHeight: 72 }}
                    value={features} onChange={e => setFeatures(e.target.value)}
                    placeholder="e.g. Updated kitchen, large backyard, move-in ready" />
                </div>
              )}
            </>
          )}

          {/* ── Content post guided fields ── */}
          {isContent && contentFields.map(field => (
            <div className="form-group" key={field.key}>
              <label className="form-label">{field.label}</label>
              {field.type === 'textarea' ? (
                <textarea className="form-control form-control--textarea" style={{ minHeight: 72 }}
                  value={contentData[field.key] || ''}
                  onChange={e => setContentField(field.key, e.target.value)}
                  placeholder={field.placeholder} />
              ) : field.type === 'select' ? (
                <select className="form-control filter-select"
                  value={contentData[field.key] || ''}
                  onChange={e => setContentField(field.key, e.target.value)}>
                  <option value="">Select…</option>
                  {field.options.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input className="form-control"
                  value={contentData[field.key] || ''}
                  onChange={e => setContentField(field.key, e.target.value)}
                  placeholder={field.placeholder} />
              )}
            </div>
          ))}

          <button className="btn btn--primary" onClick={generate} disabled={generating}
            style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}>
            {generating
              ? <><Icon name="refresh" size={14} /> Generating…</>
              : <><Icon name="sparkles" size={14} /> Generate Caption</>}
          </button>
        </div>

        {/* ─────────── RIGHT: output ─────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Caption output */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Generated Caption</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {caption && isContent && (
                  <button className="btn btn--ghost btn--sm"
                    onClick={() => exportCard(postType, caption, activeAgent?.name)}
                    title="Open a screenshot-ready branded card">
                    <Icon name="document" size={12} /> Export Card
                  </button>
                )}
                {caption && (
                  <button className="btn btn--ghost btn--sm" onClick={copyCaption}>
                    <Icon name="copy" size={12} /> {copied ? 'Copied!' : 'Copy'}
                  </button>
                )}
              </div>
            </div>

            {generating && !caption ? (
              <div style={{ color: 'var(--gw-mist)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                Writing your caption…
              </div>
            ) : caption ? (
              <div>
                <textarea
                  className="form-control form-control--textarea"
                  style={{ minHeight: 200, fontSize: 13, lineHeight: 1.7,
                    borderColor: igOverLimit ? 'var(--gw-amber)' : undefined }}
                  value={caption}
                  onChange={e => setCaption(e.target.value)}
                />
                <div style={{ marginTop: 8, fontSize: 11, display: 'flex', gap: 12,
                  color: igOverLimit ? 'var(--gw-amber)' : 'var(--gw-mist)' }}>
                  <span>{charCount} chars total</span>
                  {platform === 'Instagram' && (
                    <span style={{ fontWeight: igOverLimit ? 700 : 400 }}>
                      {bodyOnlyCount} body chars {igOverLimit ? '⚠ over 240 — trim before posting' : '✓'}
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', color: 'var(--gw-mist)' }}>
                    Edit above before copying
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--gw-mist)', fontSize: 13, padding: '40px 0', textAlign: 'center',
                borderRadius: 'var(--radius)', border: '2px dashed var(--gw-border)' }}>
                Fill in the details and click<br /><strong>Generate Caption</strong>
              </div>
            )}
          </div>

          {/* Content post: branded card preview */}
          {isContent && cardStyle && (
            <div style={{ borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--gw-border)' }}>
              <div style={{ background: 'var(--gw-bone)', borderBottom: '1px solid var(--gw-border)',
                padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Card Preview
                </div>
                {caption && (
                  <button className="btn btn--ghost btn--sm"
                    onClick={() => exportCard(postType, caption, activeAgent?.name)}>
                    <Icon name="document" size={11} /> Open Full Card
                  </button>
                )}
              </div>
              <div style={{ background: cardStyle.bg, padding: '22px 20px 18px', minHeight: 160, position: 'relative' }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase',
                  color: cardStyle.accent, marginBottom: 12 }}>
                  {postTypeMeta?.label}
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: cardStyle.text, whiteSpace: 'pre-wrap',
                  maxHeight: 140, overflow: 'hidden',
                  maskImage: caption ? 'linear-gradient(to bottom, black 80%, transparent 100%)' : 'none',
                  WebkitMaskImage: caption ? 'linear-gradient(to bottom, black 80%, transparent 100%)' : 'none' }}>
                  {caption || <span style={{ opacity: 0.4 }}>Your caption will appear here as a branded card preview…</span>}
                </div>
                <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${cardStyle.border}`,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: cardStyle.accent }}>
                    {activeAgent?.name || 'Gateway Real Estate Advisors'}
                  </span>
                  <span style={{ fontSize: 9, color: cardStyle.border, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    Gateway Real Estate Advisors
                  </span>
                </div>
              </div>
              <div style={{ background: 'var(--gw-bone)', borderTop: '1px solid var(--gw-border)',
                padding: '7px 14px', fontSize: 11, color: 'var(--gw-mist)', lineHeight: 1.5 }}>
                No Canva template needed — generate caption, click <strong>Open Full Card</strong>, then screenshot or print to PDF.
              </div>
            </div>
          )}

          {/* Property post: Canva toolkit launcher */}
          {isProperty && (
            toolkitUrl ? (
              <div className="card" style={{ padding: 16 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Next Step: Design in Canva</div>
                <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 12, lineHeight: 1.6 }}>
                  Copy your caption, then open the Gateway Toolkit to apply it to your Canva template.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {caption && (
                    <button className="btn btn--secondary btn--sm" onClick={copyCaption}>
                      <Icon name="copy" size={12} /> {copied ? 'Copied!' : 'Copy Caption'}
                    </button>
                  )}
                  <a href={toolkitUrl} target="_blank" rel="noopener noreferrer"
                    className="btn btn--primary btn--sm" style={{ textDecoration: 'none' }}>
                    <Icon name="om" size={12} /> Open Gateway Toolkit →
                  </a>
                </div>
              </div>
            ) : (
              <div style={{ background: 'var(--gw-sky)', border: '1px solid #c5d9f5', borderRadius: 'var(--radius)', padding: 14 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--gw-azure)', marginBottom: 6 }}>Connect Gateway Toolkit</div>
                <div style={{ fontSize: 12, color: 'var(--gw-mist)', lineHeight: 1.6 }}>
                  Add your Toolkit URL in <strong>Settings → Gateway Toolkit</strong> for one-click Canva access.
                </div>
              </div>
            )
          )}

          {/* Platform tips */}
          <div style={{ background: 'var(--gw-bone)', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--gw-mist)', marginBottom: 6 }}>
              {platform} Guidelines
            </div>
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', lineHeight: 1.7 }}>{PLATFORM_NOTES[platform]}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

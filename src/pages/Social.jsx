import React, { useState, useCallback, useMemo } from 'react'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase.js'
import { Icon, pushToast } from '../components/UI.jsx'

async function loadUserKey() {
  const { data: { user } } = await supabase.auth.getUser()
  return user?.user_metadata?.anthropic_key || localStorage.getItem('gw_anthropic_key') || ''
}

// Post types that can pull from a CRM property
const PROPERTY_POST_TYPES = new Set(['listing', 'sold', 'openhouse', 'price_drop', 'just_leased'])

const POST_TYPES = [
  { id: 'listing',      label: '🏠 New Listing',        desc: 'Announce a new property to market' },
  { id: 'sold',         label: '🎉 Just Sold',           desc: 'Celebrate a closed transaction' },
  { id: 'openhouse',    label: '🚪 Open House',          desc: 'Invite followers to an upcoming showing' },
  { id: 'price_drop',   label: '🏷️ Price Reduced',       desc: 'Alert followers to a price improvement' },
  { id: 'just_leased',  label: '🔑 Just Leased',         desc: 'Announce a lease signing' },
  { id: 'market',       label: '📊 Market Update',       desc: 'Share local market insights' },
  { id: 'neighborhood', label: '🏘️ Neighborhood Feature', desc: 'Spotlight a local area or community' },
  { id: 'testimonial',  label: '⭐ Client Story',         desc: 'Share a client success or testimonial' },
  { id: 'spotlight',    label: '👤 Agent Spotlight',     desc: 'Introduce a team member' },
  { id: 'tip',          label: '💡 Real Estate Tip',     desc: 'Educational content for buyers/sellers' },
]

const PLATFORMS = ['Instagram', 'Facebook', 'LinkedIn']

const PLATFORM_NOTES = {
  Instagram: 'Casual, visual, emoji-friendly. Include 5–10 hashtags. Under 2,200 chars.',
  Facebook:  'Conversational, community-focused. 1–3 sentences + call to action.',
  LinkedIn:  'Professional, educational tone. No hashtag overload — 2–3 max.',
}

// Field config per post type  { address, price, beds, baths, features, extra }
const FIELD_CONFIG = {
  listing:      { address: 'Property Address', price: 'List Price',   features: 'Key Features / Highlights', beds: true, baths: true },
  sold:         { address: 'Property Address', price: 'Sale Price',   features: 'Notable Details' },
  openhouse:    { address: 'Property Address', price: 'Asking Price', features: 'Date & Time (e.g. Sat Nov 9 · 1–4 PM)', beds: true, baths: true },
  price_drop:   { address: 'Property Address', price: 'New Price',    features: 'Previous Price & Key Selling Points' },
  just_leased:  { address: 'Property Address', price: 'Monthly Rent', features: 'Property Highlights' },
  market:       { address: 'Market / Neighborhood', features: 'Key Stats or Insight (e.g. "inventory down 12% vs last year")' },
  neighborhood: { address: 'Neighborhood / Area Name', features: 'What Makes It Special (restaurants, parks, schools, vibe)' },
  testimonial:  { address: 'Client First Name (optional)', features: 'Their Story / What They Wanted & Found' },
  spotlight:    { address: 'Agent Name', features: 'Specialties, Years of Experience, Fun Fact' },
  tip:          { address: 'Topic / Title', features: 'Target Audience & Key Points' },
}

const POST_PROMPTS = {
  listing: (d) => `Write a compelling real estate social media post announcing a new listing.
Address: ${d.address || ''}
Price: ${d.price || ''}
Beds/Baths: ${d.beds || ''} bed / ${d.baths || ''} bath
Key features: ${d.features || ''}
Platform: ${d.platform}
${PLATFORM_NOTES[d.platform]}
Include a call to action. End with emojis and ${d.platform === 'Instagram' ? '7–10 relevant hashtags' : d.platform === 'LinkedIn' ? '2–3 hashtags' : '3–5 hashtags'}. Under 250 words.`,

  sold: (d) => `Write a celebratory "Just Sold" social media post for a real estate agent.
Property: ${d.address || ''}
Sale Price: ${d.price || ''}
Details: ${d.features || ''}
Platform: ${d.platform}
${PLATFORM_NOTES[d.platform]}
Warm, celebratory, professional. Thank the client without naming them. Include hashtags for ${d.platform}. Under 200 words.`,

  openhouse: (d) => `Write an open house invitation social media post.
Property: ${d.address || ''}
Price: ${d.price || ''}
Beds/Baths: ${d.beds || ''} bed / ${d.baths || ''} bath
Date/Time: ${d.features || ''}
Platform: ${d.platform}
${PLATFORM_NOTES[d.platform]}
Make it inviting and create urgency. Include RSVP or visit call-to-action. Include hashtags. Under 200 words.`,

  price_drop: (d) => `Write an exciting "Price Reduced" social media post.
Property: ${d.address || ''}
New Price: ${d.price || ''}
Context: ${d.features || ''}
Platform: ${d.platform}
${PLATFORM_NOTES[d.platform]}
Emphasize the opportunity and value. Create a sense of urgency — this won't last. Include hashtags. Under 200 words.`,

  just_leased: (d) => `Write a "Just Leased" social media post for a real estate agent.
Property: ${d.address || ''}
Monthly Rent: ${d.price || ''}
Highlights: ${d.features || ''}
Platform: ${d.platform}
${PLATFORM_NOTES[d.platform]}
Celebratory and professional. Mention availability for similar properties. Include hashtags. Under 175 words.`,

  market: (d) => `Write a real estate market update social media post.
Market/Area: ${d.address || 'Local market'}
Key stats or insight: ${d.features || ''}
Platform: ${d.platform}
${PLATFORM_NOTES[d.platform]}
Informative but accessible. Position the agent as a trusted local expert. End with a question to drive engagement. Include hashtags. Under 250 words.`,

  neighborhood: (d) => `Write a neighborhood feature social media post for a real estate agent.
Neighborhood: ${d.address || ''}
Highlights: ${d.features || ''}
Platform: ${d.platform}
${PLATFORM_NOTES[d.platform]}
Paint a vivid picture of the community lifestyle. Tie it back to the real estate opportunity. Include hashtags. Under 250 words.`,

  testimonial: (d) => `Write a client story / testimonial social media post for a real estate agent.
Client (first name only if provided): ${d.address || 'A recent client'}
Their story: ${d.features || ''}
Platform: ${d.platform}
${PLATFORM_NOTES[d.platform]}
Warm, human, and authentic. Do NOT fabricate specifics beyond what's provided. End with a soft call to action for future clients. Include hashtags. Under 225 words.`,

  spotlight: (d) => `Write an agent spotlight social media post.
Agent name: ${d.address || ''}
Specialties/bio: ${d.features || ''}
Platform: ${d.platform}
${PLATFORM_NOTES[d.platform]}
Personal, warm, and highlight what makes this agent great. Under 200 words.`,

  tip: (d) => `Write a real estate tip or educational post for social media.
Topic: ${d.address || ''}
Audience: ${d.features || 'home buyers and sellers'}
Platform: ${d.platform}
${PLATFORM_NOTES[d.platform]}
Helpful, clear, end with a CTA. Under 250 words.`,
}

// Format a property from the CRM into social fields
function propertyToFields(p) {
  if (!p) return { address: '', price: '', beds: '', baths: '', features: '' }
  const d = p.details || {}
  const addr = [p.address, p.city, p.state].filter(Boolean).join(', ')
  const priceStr = p.price ? `$${Number(p.price).toLocaleString()}` : ''
  const bedsStr  = d.beds  || p.beds  || ''
  const bathsStr = d.baths || p.baths || ''
  const featureParts = []
  if (p.sqft)        featureParts.push(`${Number(p.sqft).toLocaleString()} sqft`)
  if (p.year_built)  featureParts.push(`Built ${p.year_built}`)
  if (p.garage)      featureParts.push(`${p.garage}-car garage`)
  if (d.pool)        featureParts.push('Pool')
  if (p.description) featureParts.push(p.description.slice(0, 120))
  return { address: addr, price: priceStr, beds: String(bedsStr), baths: String(bathsStr), features: featureParts.join(' · ') }
}

export default function SocialPage({ db, activeAgent }) {
  const [postType,   setPostType]   = useState('listing')
  const [platform,   setPlatform]   = useState('Instagram')
  const [selectedPropId, setSelectedPropId] = useState('')
  const [address,    setAddress]    = useState('')
  const [price,      setPrice]      = useState('')
  const [beds,       setBeds]       = useState('')
  const [baths,      setBaths]      = useState('')
  const [features,   setFeatures]   = useState('')
  const [caption,    setCaption]    = useState('')
  const [generating, setGenerating] = useState(false)
  const [copied,     setCopied]     = useState(false)

  const toolkitUrl = localStorage.getItem('gw_toolkit_url') || ''

  // Properties available in CRM for this post type
  const crmProperties = useMemo(() => {
    if (!PROPERTY_POST_TYPES.has(postType)) return []
    const props = db?.properties || []
    // For sold/just_leased, show sold/leased; for others show active/pending
    if (postType === 'sold') return props.filter(p => p.status === 'sold')
    if (postType === 'just_leased') return props.filter(p => p.status === 'leased')
    return props.filter(p => p.status === 'active' || p.status === 'pending')
  }, [db?.properties, postType])

  const handlePropSelect = useCallback((propId) => {
    setSelectedPropId(propId)
    setCaption('')
    if (!propId) return
    const prop = (db?.properties || []).find(p => p.id === propId)
    const filled = propertyToFields(prop)
    setAddress(filled.address)
    setPrice(filled.price)
    setBeds(filled.beds)
    setBaths(filled.baths)
    setFeatures(filled.features)
  }, [db?.properties])

  const handlePostTypeChange = (id) => {
    setPostType(id)
    setCaption('')
    setSelectedPropId('')
    setAddress(''); setPrice(''); setBeds(''); setBaths(''); setFeatures('')
  }

  const f = FIELD_CONFIG[postType] || {}
  const showPropertyPicker = PROPERTY_POST_TYPES.has(postType) && crmProperties.length > 0

  const generate = useCallback(async () => {
    const apiKey = await loadUserKey()
    if (!apiKey) { pushToast('Add your Anthropic API key in Settings → AI Configuration', 'error'); return }
    setGenerating(true)
    setCaption('')
    try {
      const promptFn = POST_PROMPTS[postType]
      const prompt = promptFn({ address, price, beds, baths, features, platform })
      const agentName = activeAgent?.name || 'a Gateway Real Estate advisor'
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 60000 })
      const stream = client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: `You are a social media content writer for Gateway Real Estate Advisors. The agent posting is ${agentName}. Write engaging, on-brand real estate posts. Be professional yet personable. Use emojis naturally. Do NOT include quotes around the post. Return only the post text, nothing else.`,
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
  }, [postType, platform, address, price, beds, baths, features, activeAgent])

  const copyCaption = () => {
    navigator.clipboard.writeText(caption)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    pushToast('Caption copied to clipboard')
  }

  return (
    <div className="page-content" style={{ maxWidth: 900 }}>
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
        {/* ── LEFT: inputs ── */}
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 16 }}>Post Details</div>

          {/* Post type grid */}
          <div className="form-group">
            <label className="form-label">Post Type</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {POST_TYPES.map(pt => (
                <label key={pt.id}
                  title={pt.desc}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
                    border: `1px solid ${postType === pt.id ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                    borderRadius: 'var(--radius)', cursor: 'pointer',
                    background: postType === pt.id ? 'var(--gw-sky)' : '#fff',
                    transition: 'all 150ms', fontSize: 12 }}>
                  <input type="radio" name="postType" value={pt.id} checked={postType === pt.id}
                    onChange={() => handlePostTypeChange(pt.id)} style={{ display: 'none' }} />
                  <span>{pt.label}</span>
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
                    fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600,
                    transition: 'all 150ms',
                    background: platform === p ? 'var(--gw-slate)' : '#fff',
                    color:      platform === p ? '#fff'            : 'var(--gw-mist)' }}>
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* CRM Property picker */}
          {showPropertyPicker && (
            <div className="form-group">
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="properties" size={12} />
                Pull from CRM Property
              </label>
              <select className="form-control filter-select"
                value={selectedPropId}
                onChange={e => handlePropSelect(e.target.value)}>
                <option value="">— Enter details manually —</option>
                {crmProperties.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.address}{p.city ? `, ${p.city}` : ''}
                    {p.price ? ` · $${Number(p.price).toLocaleString()}` : ''}
                  </option>
                ))}
              </select>
              {selectedPropId && (
                <div style={{ fontSize: 11, color: 'var(--gw-azure)', marginTop: 4 }}>
                  ✓ Fields pre-filled from CRM — edit any field below to customise.
                </div>
              )}
            </div>
          )}

          {/* Dynamic fields */}
          {f.address && (
            <div className="form-group">
              <label className="form-label">{f.address}</label>
              <input className="form-control" value={address}
                onChange={e => { setAddress(e.target.value); setSelectedPropId('') }}
                placeholder={f.address} />
            </div>
          )}
          {f.price && (
            <div className="form-group">
              <label className="form-label">{f.price}</label>
              <input className="form-control" value={price}
                onChange={e => { setPrice(e.target.value); setSelectedPropId('') }}
                placeholder="e.g. $425,000" />
            </div>
          )}
          {f.beds && (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Beds</label>
                <input className="form-control" type="number" value={beds}
                  onChange={e => setBeds(e.target.value)} placeholder="3" />
              </div>
              <div className="form-group">
                <label className="form-label">Baths</label>
                <input className="form-control" type="number" value={baths}
                  onChange={e => setBaths(e.target.value)} placeholder="2" />
              </div>
            </div>
          )}
          {f.features && (
            <div className="form-group">
              <label className="form-label">{f.features}</label>
              <textarea className="form-control form-control--textarea" style={{ minHeight: 80 }}
                value={features}
                onChange={e => setFeatures(e.target.value)}
                placeholder="e.g. Updated kitchen, large backyard, move-in ready" />
            </div>
          )}

          <button className="btn btn--primary" onClick={generate} disabled={generating}
            style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}>
            {generating
              ? <><Icon name="refresh" size={14} /> Generating…</>
              : <><Icon name="sparkles" size={14} /> Generate Caption</>}
          </button>
        </div>

        {/* ── RIGHT: output ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Generated Caption</div>
              {caption && (
                <button className="btn btn--ghost btn--sm" onClick={copyCaption}>
                  <Icon name="copy" size={12} /> {copied ? 'Copied!' : 'Copy'}
                </button>
              )}
            </div>
            {generating && !caption ? (
              <div style={{ color: 'var(--gw-mist)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                Writing your caption…
              </div>
            ) : caption ? (
              <div>
                <textarea
                  className="form-control form-control--textarea"
                  style={{ minHeight: 220, fontSize: 13, lineHeight: 1.7 }}
                  value={caption}
                  onChange={e => setCaption(e.target.value)}
                />
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--gw-mist)' }}>
                  {caption.length} chars · Edit the caption above before copying.
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--gw-mist)', fontSize: 13, padding: '40px 0', textAlign: 'center',
                borderRadius: 'var(--radius)', border: '2px dashed var(--gw-border)' }}>
                Fill in the details and click<br /><strong>Generate Caption</strong> to create your post.
              </div>
            )}
          </div>

          {/* Toolkit launcher */}
          {toolkitUrl ? (
            <div className="card" style={{ padding: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Next Step: Design in Canva</div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 12, lineHeight: 1.6 }}>
                Copy your caption above, then open the Gateway Toolkit to apply it to your Canva template.
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
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--gw-azure)', marginBottom: 6 }}>
                Connect Your Gateway Toolkit
              </div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', lineHeight: 1.6 }}>
                Add your Gateway Toolkit URL in <strong>Settings → Gateway Toolkit</strong> to get a
                one-click button that opens your Canva templates.
              </div>
            </div>
          )}

          {/* Platform tips */}
          <div style={{ background: 'var(--gw-bone)', border: '1px solid var(--gw-border)',
            borderRadius: 'var(--radius)', padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.07em', color: 'var(--gw-mist)', marginBottom: 8 }}>
              {platform} Tips
            </div>
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', lineHeight: 1.7 }}>
              {PLATFORM_NOTES[platform]}
            </div>
          </div>

          {/* Post type hint */}
          {POST_TYPES.find(pt => pt.id === postType) && (
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', lineHeight: 1.6,
              background: 'var(--gw-bone)', borderRadius: 'var(--radius)',
              padding: '10px 14px', border: '1px solid var(--gw-border)' }}>
              <strong>{POST_TYPES.find(pt => pt.id === postType).label}</strong> — {POST_TYPES.find(pt => pt.id === postType).desc}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import React, { useState, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatCurrency } from '../lib/helpers.js'
import { Icon, SearchDropdown, pushToast } from '../components/UI.jsx'

async function loadUserKey() {
  const { data: { user } } = await supabase.auth.getUser()
  return user?.user_metadata?.anthropic_key || localStorage.getItem('gw_anthropic_key') || ''
}

// ─── Section definitions ───────────────────────────────────────────────────────
const SECTION_DEFS = [
  { id: 'summary',     label: 'Executive Summary',      icon: 'document', hint: 'High-level investment opportunity overview' },
  { id: 'property',    label: 'Property Overview',      icon: 'building', hint: 'Physical description, condition, notable features' },
  { id: 'financial',   label: 'Financial Analysis',     icon: 'commission', hint: 'NOI, cap rate, cash-on-cash, debt service, projections' },
  { id: 'market',      label: 'Market Overview',        icon: 'reports', hint: 'Local market dynamics, submarket trends, demand drivers' },
  { id: 'thesis',      label: 'Investment Thesis',      icon: 'star', hint: 'Value-add opportunities, exit strategy, risk factors' },
  { id: 'highlights',  label: 'Investment Highlights',  icon: 'check', hint: 'Bulleted key reasons to invest — used on cover page' },
]

const TYPE_LABELS = {
  residential: 'Residential', multifamily: 'Multifamily', office: 'Office',
  land: 'Land', retail: 'Retail', industrial: 'Industrial', 'mixed-use': 'Mixed-Use', rental: 'Rental',
}

const COMMERCIAL_TYPES = ['multifamily', 'office', 'land', 'retail', 'industrial', 'mixed-use']
const isCommercial = (t) => COMMERCIAL_TYPES.includes(t)

// ─── Build context string for AI prompts ──────────────────────────────────────
function buildPropertyContext(p, financials) {
  const d = p.details || {}
  const lines = [
    `Address: ${[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')}`,
    `Property Type: ${TYPE_LABELS[p.type] || p.type}`,
    `Asking Price: ${p.list_price ? formatCurrency(p.list_price) : 'Not disclosed'}`,
    p.sqft ? `Square Footage: ${Number(p.sqft).toLocaleString()} sqft` : '',
    p.mls_number ? `MLS #: ${p.mls_number}` : '',
    d.year_built ? `Year Built: ${d.year_built}` : '',
    // Multifamily
    d.total_units ? `Total Units: ${d.total_units}` : '',
    d.unit_mix ? `Unit Mix: ${d.unit_mix}` : '',
    // Office
    d.floors ? `Floors: ${d.floors}` : '',
    d.class ? `Class: ${d.class}` : '',
    // Land
    d.acres ? `Acres: ${d.acres}` : '',
    d.zoning ? `Zoning: ${d.zoning}` : '',
    d.land_status ? `Land Status: ${d.land_status}` : '',
    // Industrial
    d.clear_height ? `Clear Height: ${d.clear_height} ft` : '',
    d.loading_docks ? `Loading Docks: ${d.loading_docks}` : '',
    // NOI/Financial
    d.annual_income ? `Annual Gross Income: ${formatCurrency(Number(d.annual_income))}` : '',
    d.annual_expenses ? `Annual Operating Expenses: ${formatCurrency(Number(d.annual_expenses))}` : '',
    d.vacancy_pct ? `Vacancy Rate: ${d.vacancy_pct}%` : '',
    p.notes ? `Notes: ${p.notes}` : '',
  ].filter(Boolean)

  if (financials.noi > 0) {
    lines.push(`NOI: ${formatCurrency(financials.noi)}`)
    if (financials.capRate) lines.push(`Cap Rate: ${financials.capRate.toFixed(2)}%`)
    if (financials.grm) lines.push(`GRM: ${financials.grm.toFixed(1)}×`)
  }

  return lines.join('\n')
}

// ─── Section prompt builders ──────────────────────────────────────────────────
const SECTION_PROMPTS = {
  summary: (ctx, agentName) => `You are writing the Executive Summary section of a commercial real estate Offering Memorandum (OM).

Property Details:
${ctx}

Agent/Broker: ${agentName || 'Gateway Real Estate Advisors'}

Write a compelling 2-3 paragraph executive summary suitable for institutional and private equity investors. Include the investment opportunity, key financial metrics (if available), and a brief market positioning statement. Professional tone — no fluff, no fabrication. Only reference data provided.`,

  property: (ctx) => `You are writing the Property Overview section of a commercial real estate Offering Memorandum.

Property Details:
${ctx}

Write 2-3 paragraphs describing the physical property, its condition, location characteristics, and notable features. Reference only the data provided. Be specific and factual. If data is missing, note that it is available upon request rather than fabricating.`,

  financial: (ctx) => `You are writing the Financial Analysis section of a commercial real estate Offering Memorandum.

Property Details:
${ctx}

Write a professional financial analysis section covering income, expenses, NOI, and relevant valuation metrics based on the data provided. If financials are incomplete, present what is available and note additional materials can be provided to qualified buyers. Include a brief note on financing assumptions if applicable.`,

  market: (ctx, city, state) => `You are writing the Market Overview section of a commercial real estate Offering Memorandum.

Property Location: ${city ? `${city}, ${state}` : 'the subject market'}
Property Details:
${ctx}

Write 2-3 paragraphs covering local market dynamics, submarket trends, population and employment drivers, and demand factors relevant to this property type. Base the narrative on the property type and location provided. Note that all market data should be verified with current sources.`,

  thesis: (ctx) => `You are writing the Investment Thesis section of a commercial real estate Offering Memorandum.

Property Details:
${ctx}

Write a compelling investment thesis covering: (1) primary value drivers, (2) value-add or repositioning opportunities, (3) exit strategy options, and (4) key risk factors with mitigants. Be direct and honest — sophisticated investors appreciate clear risk disclosure. 2-3 paragraphs.`,

  highlights: (ctx) => `You are writing the Investment Highlights section of a commercial real estate Offering Memorandum.

Property Details:
${ctx}

Generate 5-7 concise bullet points (one line each) summarizing the strongest reasons to invest. Start each bullet with a strong noun or metric. Format as a plain bulleted list using "•" as the bullet character. No fabrication — only reference data provided.`,
}

// ─── Compute NOI/cap from property ────────────────────────────────────────────
function calcFinancials(p) {
  const d = p?.details || {}
  const inc  = Number(d.annual_income   || 0)
  const vac  = Number(d.vacancy_pct     || 0)
  const exp  = Number(d.annual_expenses || 0)
  const price = Number(p?.list_price    || 0)
  if (inc <= 0) return { noi: 0, capRate: null, grm: null }
  const egi     = inc * (1 - vac / 100)
  const noi     = egi - exp
  const capRate = price > 0 ? (noi / price * 100) : null
  const grm     = price > 0 ? (price / inc) : null
  return { noi, capRate, grm }
}

// ─── PDF Export ───────────────────────────────────────────────────────────────
function exportOM({ property, sections, agentName, financials }) {
  const d = property.details || {}
  const address = [property.address, property.city, property.state, property.zip].filter(Boolean).join(', ')
  const propType = TYPE_LABELS[property.type] || property.type
  const photos = (d.photos || []).slice(0, 6)

  const sectionHtml = SECTION_DEFS
    .filter(sd => sections[sd.id]?.trim())
    .map(sd => `
      <div class="section">
        <h2 class="section-title">${sd.label}</h2>
        <div class="section-body">${sections[sd.id].replace(/\n/g, '<br>').replace(/•/g, '&#8226;')}</div>
      </div>`)
    .join('')

  const financialCards = [
    financials.noi > 0 && `<div class="fin-card"><div class="fin-val">${formatCurrency(financials.noi)}</div><div class="fin-lbl">NOI</div></div>`,
    financials.capRate && `<div class="fin-card"><div class="fin-val">${financials.capRate.toFixed(2)}%</div><div class="fin-lbl">Cap Rate</div></div>`,
    financials.grm && `<div class="fin-card"><div class="fin-val">${financials.grm.toFixed(1)}×</div><div class="fin-lbl">GRM</div></div>`,
    property.list_price && `<div class="fin-card"><div class="fin-val">${formatCurrency(property.list_price)}</div><div class="fin-lbl">Asking Price</div></div>`,
    property.sqft && `<div class="fin-card"><div class="fin-val">${Number(property.sqft).toLocaleString()}</div><div class="fin-lbl">Sq Ft</div></div>`,
    d.total_units && `<div class="fin-card"><div class="fin-val">${d.total_units}</div><div class="fin-lbl">Units</div></div>`,
    d.year_built && `<div class="fin-card"><div class="fin-val">${d.year_built}</div><div class="fin-lbl">Year Built</div></div>`,
  ].filter(Boolean).join('')

  const photoGrid = photos.length > 0 ? `
    <div class="section">
      <h2 class="section-title">Photo Gallery</h2>
      <div class="photo-grid">
        ${photos.map(url => `<img src="${url}" alt="Property photo" class="photo-thumb" />`).join('')}
      </div>
    </div>` : ''

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Offering Memorandum — ${address}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Georgia', 'Times New Roman', serif; color: #1a2236; background: #fff; }
  .cover { background: #1a2236; color: #fff; min-height: 100vh; display: flex; flex-direction: column; justify-content: space-between; padding: 60px 72px; page-break-after: always; }
  .cover-badge { font-family: -apple-system, sans-serif; font-size: 11px; font-weight: 800; letter-spacing: 0.15em; text-transform: uppercase; color: #c9a84c; margin-bottom: 48px; }
  .cover-type { font-family: -apple-system, sans-serif; font-size: 14px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #8fa3c4; margin-bottom: 12px; }
  .cover-address { font-family: -apple-system, sans-serif; font-size: 36px; font-weight: 700; line-height: 1.2; color: #fff; margin-bottom: 8px; }
  .cover-city { font-family: -apple-system, sans-serif; font-size: 22px; color: #8fa3c4; margin-bottom: 40px; }
  .cover-divider { height: 2px; background: #c9a84c; width: 60px; margin-bottom: 36px; }
  .cover-metrics { display: flex; gap: 40px; flex-wrap: wrap; }
  .cover-metric { }
  .cover-metric-val { font-family: -apple-system, sans-serif; font-size: 24px; font-weight: 700; color: #fff; }
  .cover-metric-lbl { font-family: -apple-system, sans-serif; font-size: 11px; color: #8fa3c4; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 2px; }
  .cover-footer { font-family: -apple-system, sans-serif; font-size: 12px; color: #4a6080; }
  .cover-agent { font-weight: 700; color: #8fa3c4; font-size: 14px; margin-bottom: 6px; }
  .cover-disclaimer { font-size: 10px; color: #3a4a60; line-height: 1.6; margin-top: 16px; max-width: 600px; }
  .cover-photo { width: 100%; height: 300px; object-fit: cover; border-radius: 4px; margin: 32px 0; opacity: 0.7; }
  .content { max-width: 800px; margin: 0 auto; padding: 60px 48px; }
  .highlights-bar { background: #f8f9fb; border-left: 4px solid #c9a84c; padding: 24px 32px; margin-bottom: 48px; }
  .highlights-title { font-family: -apple-system, sans-serif; font-size: 11px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: #c9a84c; margin-bottom: 16px; }
  .highlights-text { font-family: -apple-system, sans-serif; font-size: 13px; line-height: 2; color: #1a2236; }
  .fin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 1px; background: #e5e7eb; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; margin-bottom: 48px; }
  .fin-card { background: #fff; padding: 16px; text-align: center; }
  .fin-val { font-family: -apple-system, sans-serif; font-size: 18px; font-weight: 700; color: #1a2236; }
  .fin-lbl { font-family: -apple-system, sans-serif; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin-top: 4px; }
  .section { margin-bottom: 48px; page-break-inside: avoid; }
  .section-title { font-family: -apple-system, sans-serif; font-size: 11px; font-weight: 800; letter-spacing: 0.15em; text-transform: uppercase; color: #c9a84c; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid #e5e7eb; }
  .section-body { font-size: 14px; line-height: 1.85; color: #374151; }
  .photo-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 16px; }
  .photo-thumb { width: 100%; height: 180px; object-fit: cover; border-radius: 4px; }
  .confidential { background: #fff3cd; border: 1px solid #ffc107; padding: 12px 20px; font-family: -apple-system, sans-serif; font-size: 11px; color: #856404; text-align: center; }
  @media print {
    .cover { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .highlights-bar { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .fin-grid { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .section { page-break-inside: avoid; }
  }
</style>
</head>
<body>

<!-- CONFIDENTIALITY NOTICE -->
<div class="confidential">
  CONFIDENTIAL — This Offering Memorandum is intended solely for the use of the recipient and may not be reproduced or distributed without prior written consent.
</div>

<!-- COVER PAGE -->
<div class="cover">
  <div>
    <div class="cover-badge">Offering Memorandum · ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}</div>
    <div class="cover-type">${propType}</div>
    <div class="cover-address">${property.address || 'Property Address'}</div>
    ${property.city ? `<div class="cover-city">${[property.city, property.state, property.zip].filter(Boolean).join(', ')}</div>` : ''}
    <div class="cover-divider"></div>
    ${financialCards ? `<div class="cover-metrics">${
      [
        property.list_price && `<div class="cover-metric"><div class="cover-metric-val">${formatCurrency(property.list_price)}</div><div class="cover-metric-lbl">Asking Price</div></div>`,
        financials.capRate && `<div class="cover-metric"><div class="cover-metric-val">${financials.capRate.toFixed(2)}%</div><div class="cover-metric-lbl">Cap Rate</div></div>`,
        financials.noi > 0 && `<div class="cover-metric"><div class="cover-metric-val">${formatCurrency(financials.noi)}</div><div class="cover-metric-lbl">NOI</div></div>`,
        d.total_units && `<div class="cover-metric"><div class="cover-metric-val">${d.total_units}</div><div class="cover-metric-lbl">Units</div></div>`,
      ].filter(Boolean).join('')
    }</div>` : ''}
    ${photos[0] ? `<img src="${photos[0]}" class="cover-photo" alt="Property" />` : ''}
  </div>
  <div class="cover-footer">
    <div class="cover-agent">${agentName || 'Gateway Real Estate Advisors'}</div>
    <div>Exclusively Offered By — ${agentName || 'Gateway Real Estate Advisors'}</div>
    <div class="cover-disclaimer">
      The information contained in this Offering Memorandum has been obtained from sources believed to be reliable. While we do not doubt its accuracy,
      we have not verified it and make no guarantee, warranty or representation about it. Prospective buyers/investors are encouraged to perform their own
      independent investigation. This document does not purport to contain all information a prospective buyer may require.
    </div>
  </div>
</div>

<!-- MAIN CONTENT -->
<div class="content">

  ${sections.highlights ? `
  <div class="highlights-bar">
    <div class="highlights-title">Investment Highlights</div>
    <div class="highlights-text">${sections.highlights.replace(/\n/g, '<br>').replace(/•/g, '&#8226;')}</div>
  </div>` : ''}

  ${financialCards ? `<div class="fin-grid">${financialCards}</div>` : ''}

  ${SECTION_DEFS.filter(sd => sd.id !== 'highlights' && sections[sd.id]?.trim()).map(sd => `
  <div class="section">
    <div class="section-title">${sd.label}</div>
    <div class="section-body">${sections[sd.id].replace(/\n/g, '<br>').replace(/•/g, '&#8226;')}</div>
  </div>`).join('')}

  ${photoGrid}

</div>
</body>
</html>`

  const win = window.open('', '_blank')
  win.document.write(html)
  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 600)
}

// ─── Section Editor ───────────────────────────────────────────────────────────
function SectionEditor({ def, content, onChange, onGenerate, generating }) {
  return (
    <div className="card" style={{ marginBottom: 16, padding: '16px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{def.label}</div>
          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2 }}>{def.hint}</div>
        </div>
        <button
          className="btn btn--ghost btn--sm"
          style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}
          onClick={onGenerate}
          disabled={generating}
        >
          {generating === def.id ? (
            <><Icon name="refresh" size={12} /> Writing…</>
          ) : (
            <><Icon name="star" size={12} /> {content ? 'Regenerate' : 'Generate with AI'}</>
          )}
        </button>
      </div>
      <textarea
        className="form-control form-control--textarea"
        style={{ minHeight: 120, fontSize: 13, lineHeight: 1.7, resize: 'vertical' }}
        value={content}
        onChange={e => onChange(e.target.value)}
        placeholder={`Write or generate the ${def.label} section…`}
      />
      {content && (
        <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4, textAlign: 'right' }}>
          {content.length} chars · {content.split(/\s+/).filter(Boolean).length} words
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function OmPage({ db, activeAgent }) {
  const [selectedPropId, setSelectedPropId] = useState('')
  const [manualMode,     setManualMode]     = useState(false)
  const [manualProp,     setManualProp]     = useState({
    address: '', city: '', state: '', zip: '', type: 'multifamily',
    list_price: '', sqft: '', notes: '', details: {},
  })
  const [sections,   setSections]   = useState({})
  const [generating, setGenerating] = useState(null) // section id being generated
  const [genAll,     setGenAll]     = useState(false)

  const properties = db?.properties || []
  const agents     = db?.agents     || []
  const agentName  = activeAgent?.name || 'Gateway Real Estate Advisors'

  const selectedProp = useMemo(() => {
    if (manualMode) return manualProp
    return properties.find(p => p.id === selectedPropId) || null
  }, [selectedPropId, properties, manualMode, manualProp])

  const financials = useMemo(() => calcFinancials(selectedProp), [selectedProp])

  const setSection = (id, val) => setSections(prev => ({ ...prev, [id]: val }))

  const generateSection = useCallback(async (sectionId) => {
    if (!selectedProp?.address && !manualMode) {
      pushToast('Select a property first', 'error'); return
    }
    const apiKey = await loadUserKey()
    if (!apiKey) {
      pushToast('Add your Anthropic API key in Settings → AI Configuration', 'error'); return
    }
    setGenerating(sectionId)
    try {
      const ctx = buildPropertyContext(selectedProp, financials)
      const promptFn = SECTION_PROMPTS[sectionId]
      const prompt = sectionId === 'market'
        ? promptFn(ctx, selectedProp.city, selectedProp.state)
        : promptFn(ctx, agentName)

      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: 'You are an expert commercial real estate writer producing professional Offering Memorandum content. Write in a precise, institutional-quality style. Never fabricate data not provided.',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 700,
        }),
      })
      const data = await res.json()
      const text = data.content?.[0]?.text || ''
      if (!text) { pushToast('Generation failed — check API key', 'error'); return }
      setSection(sectionId, text.trim())
      pushToast(`${SECTION_DEFS.find(s => s.id === sectionId)?.label} generated`)
    } catch (e) {
      pushToast('Error: ' + e.message, 'error')
    } finally {
      setGenerating(null)
    }
  }, [selectedProp, financials, agentName, manualMode])

  const generateAllSections = async () => {
    if (!selectedProp?.address && !manualMode) {
      pushToast('Select a property first', 'error'); return
    }
    const apiKey = await loadUserKey()
    if (!apiKey) {
      pushToast('Add your Anthropic API key in Settings → AI Configuration', 'error'); return
    }
    setGenAll(true)
    for (const def of SECTION_DEFS) {
      setGenerating(def.id)
      try {
        const ctx = buildPropertyContext(selectedProp, financials)
        const promptFn = SECTION_PROMPTS[def.id]
        const prompt = def.id === 'market'
          ? promptFn(ctx, selectedProp.city, selectedProp.state)
          : promptFn(ctx, agentName)
        const res = await fetch('/api/claude', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system: 'You are an expert commercial real estate writer producing professional Offering Memorandum content. Write in a precise, institutional-quality style. Never fabricate data not provided.',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 700,
          }),
        })
        const data = await res.json()
        const text = data.content?.[0]?.text || ''
        if (text) setSection(def.id, text.trim())
      } catch { /* continue on individual section failures */ }
    }
    setGenerating(null)
    setGenAll(false)
    pushToast('All sections generated')
  }

  const clearAll = () => {
    setSections({})
    pushToast('Sections cleared', 'info')
  }

  const filledCount = SECTION_DEFS.filter(s => sections[s.id]?.trim()).length

  const setManualField = (k, v) => setManualProp(p => ({ ...p, [k]: v }))
  const setManualDetail = (k, v) => setManualProp(p => ({ ...p, details: { ...p.details, [k]: v } }))

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">OM Generator</div>
          <div className="page-sub">Offering Memorandum Builder — AI-assisted, print-ready</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {filledCount > 0 && (
            <button className="btn btn--ghost btn--sm" onClick={clearAll} title="Clear all sections">
              <Icon name="trash" size={13} /> Clear
            </button>
          )}
          {selectedProp && filledCount < SECTION_DEFS.length && !genAll && (
            <button className="btn btn--secondary" onClick={generateAllSections} disabled={!!generating}>
              <Icon name="star" size={14} /> Generate All Sections
            </button>
          )}
          {selectedProp && filledCount > 0 && (
            <button
              className="btn btn--primary"
              onClick={() => exportOM({ property: selectedProp, sections, agentName, financials })}
            >
              <Icon name="document" size={14} /> Export PDF
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 20, alignItems: 'start' }}>

        {/* ── Left Panel: Property Selection ── */}
        <div>
          <div className="card" style={{ padding: '18px 20px', marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>Property</div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <button
                className={`btn btn--sm ${!manualMode ? 'btn--primary' : 'btn--secondary'}`}
                style={{ flex: 1 }}
                onClick={() => setManualMode(false)}
              >
                From CRM
              </button>
              <button
                className={`btn btn--sm ${manualMode ? 'btn--primary' : 'btn--secondary'}`}
                style={{ flex: 1 }}
                onClick={() => setManualMode(true)}
              >
                Enter Manually
              </button>
            </div>

            {!manualMode ? (
              <>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Select Property</label>
                  <SearchDropdown
                    items={properties}
                    value={selectedPropId}
                    onSelect={setSelectedPropId}
                    placeholder="Search properties…"
                    labelKey={p => `${p.address}${p.city ? `, ${p.city}` : ''}`}
                  />
                </div>
                {properties.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 8 }}>
                    No properties found — add them in the Properties page first.
                  </div>
                )}
              </>
            ) : (
              <div>
                <div className="form-group">
                  <label className="form-label required">Address</label>
                  <input className="form-control" value={manualProp.address} onChange={e => setManualField('address', e.target.value)} placeholder="123 Main Street" />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">City</label>
                    <input className="form-control" value={manualProp.city} onChange={e => setManualField('city', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">State</label>
                    <input className="form-control" value={manualProp.state} onChange={e => setManualField('state', e.target.value)} style={{ maxWidth: 60 }} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Property Type</label>
                  <select className="form-control" value={manualProp.type} onChange={e => setManualField('type', e.target.value)}>
                    {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Asking Price ($)</label>
                    <input className="form-control" type="number" value={manualProp.list_price} onChange={e => setManualField('list_price', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Sq Ft</label>
                    <input className="form-control" type="number" value={manualProp.sqft} onChange={e => setManualField('sqft', e.target.value)} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Total Units</label>
                    <input className="form-control" type="number" value={manualProp.details.total_units || ''} onChange={e => setManualDetail('total_units', e.target.value)} placeholder="MF only" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Year Built</label>
                    <input className="form-control" type="number" value={manualProp.details.year_built || ''} onChange={e => setManualDetail('year_built', e.target.value)} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Financial Quick-Entry ── */}
          {selectedProp && (
            <div className="card" style={{ padding: '18px 20px', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>Financials</div>
              {manualMode ? (
                <>
                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label">Annual Gross Income ($)</label>
                      <input className="form-control" type="number" value={manualProp.details.annual_income || ''} onChange={e => setManualDetail('annual_income', e.target.value)} placeholder="0" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Vacancy (%)</label>
                      <input className="form-control" type="number" value={manualProp.details.vacancy_pct || ''} onChange={e => setManualDetail('vacancy_pct', e.target.value)} placeholder="5" />
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Annual Expenses ($)</label>
                    <input className="form-control" type="number" value={manualProp.details.annual_expenses || ''} onChange={e => setManualDetail('annual_expenses', e.target.value)} placeholder="0" />
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--gw-mist)', lineHeight: 1.6 }}>
                  Pulling from property record. To update financials, edit the property in the Properties page.
                </div>
              )}

              {financials.noi > 0 && (
                <div style={{ marginTop: 12, background: 'var(--gw-sky)', border: '1px solid #c5d9f5', borderRadius: 'var(--radius)', padding: '10px 14px', fontSize: 12 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                    <div><div style={{ color: 'var(--gw-mist)' }}>NOI</div><div style={{ fontWeight: 700 }}>{formatCurrency(financials.noi)}</div></div>
                    {financials.capRate && <div><div style={{ color: 'var(--gw-mist)' }}>Cap Rate</div><div style={{ fontWeight: 700, color: 'var(--gw-azure)' }}>{financials.capRate.toFixed(2)}%</div></div>}
                    {financials.grm && <div><div style={{ color: 'var(--gw-mist)' }}>GRM</div><div style={{ fontWeight: 700 }}>{financials.grm.toFixed(1)}×</div></div>}
                    {selectedProp.list_price > 0 && <div><div style={{ color: 'var(--gw-mist)' }}>Price</div><div style={{ fontWeight: 700 }}>{formatCurrency(selectedProp.list_price)}</div></div>}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Progress ── */}
          {selectedProp && (
            <div className="card" style={{ padding: '14px 20px' }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
                Sections — {filledCount} / {SECTION_DEFS.length} written
              </div>
              <div style={{ height: 6, background: 'var(--gw-border)', borderRadius: 3, overflow: 'hidden', marginBottom: 10 }}>
                <div style={{ width: `${(filledCount / SECTION_DEFS.length) * 100}%`, height: '100%', background: filledCount === SECTION_DEFS.length ? 'var(--gw-green)' : 'var(--gw-azure)', borderRadius: 3, transition: 'width 300ms' }} />
              </div>
              {SECTION_DEFS.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, fontSize: 12 }}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: sections[s.id]?.trim() ? 'var(--gw-green)' : 'var(--gw-border)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {sections[s.id]?.trim() && <Icon name="check" size={8} style={{ color: '#fff' }} />}
                  </div>
                  <span style={{ color: sections[s.id]?.trim() ? 'var(--gw-ink)' : 'var(--gw-mist)' }}>{s.label}</span>
                  {generating === s.id && <span style={{ fontSize: 10, color: 'var(--gw-azure)', fontWeight: 600 }}>Writing…</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Right Panel: Section Editors ── */}
        <div>
          {!selectedProp ? (
            <div className="card" style={{ padding: '48px 40px', textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Select a Property to Begin</div>
              <div style={{ fontSize: 13, color: 'var(--gw-mist)', maxWidth: 380, margin: '0 auto', lineHeight: 1.6 }}>
                Choose a property from your CRM or enter details manually. Then use AI to generate professional OM sections instantly.
              </div>
              {properties.length > 0 && (
                <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {properties.filter(p => isCommercial(p.type)).slice(0, 4).map(p => (
                    <button
                      key={p.id}
                      className="btn btn--secondary btn--sm"
                      onClick={() => { setManualMode(false); setSelectedPropId(p.id) }}
                    >
                      {p.address}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Property summary header */}
              <div className="card" style={{ padding: '14px 20px', marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{selectedProp.address}</div>
                    <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 2 }}>
                      {[selectedProp.city, selectedProp.state, selectedProp.zip].filter(Boolean).join(', ')}
                      {selectedProp.type && <span style={{ marginLeft: 8, fontWeight: 600, color: 'var(--gw-azure)' }}>{TYPE_LABELS[selectedProp.type] || selectedProp.type}</span>}
                    </div>
                  </div>
                  {(selectedProp.details?.photos || [])[0] && (
                    <img
                      src={(selectedProp.details.photos || [])[0]}
                      alt="Property"
                      style={{ width: 80, height: 56, objectFit: 'cover', borderRadius: 'var(--radius)', flexShrink: 0 }}
                    />
                  )}
                </div>
              </div>

              {/* Section editors */}
              {SECTION_DEFS.map(def => (
                <SectionEditor
                  key={def.id}
                  def={def}
                  content={sections[def.id] || ''}
                  onChange={val => setSection(def.id, val)}
                  onGenerate={() => generateSection(def.id)}
                  generating={generating}
                />
              ))}

              {/* Export CTA */}
              {filledCount > 0 && (
                <div style={{ padding: '16px 20px', background: 'var(--gw-sky)', border: '1px solid #c5d9f5', borderRadius: 'var(--radius)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>Ready to export</div>
                    <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 2 }}>
                      {filledCount} of {SECTION_DEFS.length} sections complete · opens print dialog
                    </div>
                  </div>
                  <button
                    className="btn btn--primary"
                    onClick={() => exportOM({ property: selectedProp, sections, agentName, financials })}
                  >
                    <Icon name="document" size={14} /> Export PDF
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

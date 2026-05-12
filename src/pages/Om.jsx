import React, { useState, useRef } from 'react'
import { Icon, pushToast } from '../components/UI.jsx'
import { generateOM } from '../lib/omBuilder.js'

const TABS = ['Property Info', 'Agents', 'Financials', 'Market', 'Photos']

const DEFAULT_PROPERTY = {
  name: 'Lincoln Way Apartments',
  address: '1000-1008 S Crawford Road',
  city: 'Vermillion, South Dakota',
  date: 'May 2026',
  askingPrice: '$2.05M',
  capRate: '6.57%',
  totalUnits: '24',
  pricePerUnit: '$85K',
  noi: '$135K',
  grm: '8.8x',
  occupancy: '100%',
  yearBuilt: '1979',
  buildings: '1',
  lotSize: '.72 Acres',
  parking: '30 Spaces',
  assetClass: 'Multifamily',
  propertyType: 'Apartment',
}

const DEFAULT_AGENTS = [
  {
    name: 'Daniel Stillson',
    title: 'Commercial Associate',
    phone: '712.739.0830',
    email: 'Daniel@gatewayreadvisors.com',
    lic: 'Licensed in Iowa, South Dakota, Nebraska',
    init: 'DS',
  },
  {
    name: 'Nic Madsen',
    title: 'VP of Commercial Sales',
    phone: '712.540.6562',
    email: 'Nic@Gatewayreadvisors.com',
    lic: 'Licensed in Iowa, South Dakota, Nebraska',
    init: 'NM',
  },
]

const DEFAULT_FINANCIALS = {
  current: {
    gri: '$245,880',
    vcl: '($12,294)',
    egi: '$233,586',
    pt: '$21,336',
    ins: '$12,732',
    mgmt: '$18,686',
    maint: '$23,358',
    util: '$18,264',
    ls: '$4,500',
    te: '$98,876',
    noi: '$134,710',
    kpiLabel: 'CURRENT INCOME',
    kpiValue: '$234K',
    kpiSub: 'Effective Gross',
    kpiNOILabel: 'CURRENT NOI',
    kpiNOIValue: '$135K',
    kpiNOISub: 'Net Operating',
  },
  proForma: {
    gri: '$268,200',
    vcl: '($13,410)',
    egi: '$254,790',
    pt: '$21,900',
    ins: '$13,000',
    mgmt: '$20,383',
    maint: '$25,479',
    util: '$18,750',
    ls: '$4,500',
    te: '$104,012',
    noi: '$150,778',
    kpiLabel: 'PRO FORMA INCOME',
    kpiValue: '$255K',
    kpiSub: 'Stabilized Gross',
    kpiNOILabel: 'PRO FORMA NOI',
    kpiNOIValue: '$151K',
    kpiNOISub: '+11.9% vs Current',
  },
}

const DEFAULT_MARKET = {
  city: 'Vermillion, South Dakota',
  population: '14,953',
  medianIncome: '$55,963',
  unemployment: '8.2%',
  avgRent: '$758',
}

// ─── Field helpers ────────────────────────────────────────────────────────────
function Field({ label, value, onChange, placeholder }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--gw-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </label>
      <input
        className="form-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || ''}
        style={{ width: '100%' }}
      />
    </div>
  )
}

function PhotoSlot({ label, photoKey, photos, onPhotoChange }) {
  const inputRef = useRef()
  const handleFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => onPhotoChange(photoKey, ev.target.result)
    reader.readAsDataURL(file)
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--gw-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div
        onClick={() => inputRef.current.click()}
        style={{
          border: photos[photoKey] ? '2px solid var(--gw-amber)' : '2px dashed var(--gw-border)',
          borderRadius: 8,
          height: 100,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          background: photos[photoKey] ? 'var(--gw-gold-light)' : 'var(--gw-surface)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {photos[photoKey] ? (
          <>
            <img src={photos[photoKey]} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', top: 0, left: 0 }} />
            <div style={{ position: 'absolute', bottom: 4, right: 4, background: 'rgba(0,0,0,0.6)', borderRadius: 4, padding: '2px 6px', fontSize: 10, color: '#fff' }}>
              Change
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', color: 'var(--gw-muted)' }}>
            <Icon name="upload" size={20} style={{ marginBottom: 4 }} />
            <div style={{ fontSize: 11 }}>Click to upload</div>
          </div>
        )}
        <input ref={inputRef} type="file" accept="image/*" onChange={handleFile} style={{ display: 'none' }} />
      </div>
    </div>
  )
}

// ─── Tab panels ───────────────────────────────────────────────────────────────
function PropertyTab({ property, setProperty }) {
  const set = (k) => (v) => setProperty(p => ({ ...p, [k]: v }))
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
        <Field label="Property Name" value={property.name} onChange={set('name')} />
        <Field label="Date" value={property.date} onChange={set('date')} />
        <Field label="Street Address" value={property.address} onChange={set('address')} />
        <Field label="City, State" value={property.city} onChange={set('city')} />
        <Field label="Asking Price" value={property.askingPrice} onChange={set('askingPrice')} placeholder="$2.05M" />
        <Field label="Cap Rate" value={property.capRate} onChange={set('capRate')} placeholder="6.57%" />
        <Field label="Total Units" value={property.totalUnits} onChange={set('totalUnits')} placeholder="24" />
        <Field label="Price Per Unit" value={property.pricePerUnit} onChange={set('pricePerUnit')} placeholder="$85K" />
        <Field label="NOI" value={property.noi} onChange={set('noi')} placeholder="$135K" />
        <Field label="GRM" value={property.grm} onChange={set('grm')} placeholder="8.8x" />
        <Field label="Occupancy" value={property.occupancy} onChange={set('occupancy')} placeholder="100%" />
        <Field label="Year Built" value={property.yearBuilt} onChange={set('yearBuilt')} placeholder="1979" />
        <Field label="Buildings" value={property.buildings} onChange={set('buildings')} placeholder="1" />
        <Field label="Lot Size" value={property.lotSize} onChange={set('lotSize')} placeholder=".72 Acres" />
        <Field label="Parking" value={property.parking} onChange={set('parking')} placeholder="30 Spaces" />
        <Field label="Asset Class" value={property.assetClass} onChange={set('assetClass')} placeholder="Multifamily" />
        <Field label="Property Type" value={property.propertyType} onChange={set('propertyType')} placeholder="Apartment" />
      </div>
    </div>
  )
}

function AgentsTab({ agents, setAgents }) {
  const setAgent = (i, k) => (v) => setAgents(arr => arr.map((a, idx) => idx === i ? { ...a, [k]: v } : a))
  return (
    <div>
      {agents.map((agent, i) => (
        <div key={i} style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--gw-text)', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid var(--gw-border)' }}>
            Agent {i + 1}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
            <Field label="Full Name" value={agent.name} onChange={setAgent(i, 'name')} />
            <Field label="Initials" value={agent.init} onChange={setAgent(i, 'init')} placeholder="DS" />
            <Field label="Title" value={agent.title} onChange={setAgent(i, 'title')} />
            <Field label="Phone" value={agent.phone} onChange={setAgent(i, 'phone')} />
            <Field label="Email" value={agent.email} onChange={setAgent(i, 'email')} />
            <Field label="License States" value={agent.lic} onChange={setAgent(i, 'lic')} />
          </div>
        </div>
      ))}
    </div>
  )
}

function FinancialsTab({ financials, setFinancials }) {
  const set = (period, k) => (v) => setFinancials(f => ({ ...f, [period]: { ...f[period], [k]: v } }))
  const rows = [
    { label: 'Gross Rental Income', key: 'gri' },
    { label: 'Vacancy & Credit Loss', key: 'vcl' },
    { label: 'Effective Gross Income', key: 'egi' },
    { label: 'Property Taxes', key: 'pt' },
    { label: 'Insurance', key: 'ins' },
    { label: 'Management', key: 'mgmt' },
    { label: 'Maintenance', key: 'maint' },
    { label: 'Utilities', key: 'util' },
    { label: 'Legal/Admin', key: 'ls' },
    { label: 'Total Expenses', key: 'te' },
    { label: 'Net Operating Income', key: 'noi' },
  ]
  const kpiRows = [
    { label: 'KPI Label (income)', key: 'kpiLabel' },
    { label: 'KPI Value (income)', key: 'kpiValue' },
    { label: 'KPI Subtitle (income)', key: 'kpiSub' },
    { label: 'KPI Label (NOI)', key: 'kpiNOILabel' },
    { label: 'KPI Value (NOI)', key: 'kpiNOIValue' },
    { label: 'KPI Subtitle (NOI)', key: 'kpiNOISub' },
  ]
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 28px' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gw-amber)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Current</div>
          {rows.map(r => (
            <Field key={r.key} label={r.label} value={financials.current[r.key]} onChange={set('current', r.key)} />
          ))}
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--gw-border)' }}>
            {kpiRows.map(r => (
              <Field key={r.key} label={r.label} value={financials.current[r.key]} onChange={set('current', r.key)} />
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gw-amber)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Pro Forma</div>
          {rows.map(r => (
            <Field key={r.key} label={r.label} value={financials.proForma[r.key]} onChange={set('proForma', r.key)} />
          ))}
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--gw-border)' }}>
            {kpiRows.map(r => (
              <Field key={r.key} label={r.label} value={financials.proForma[r.key]} onChange={set('proForma', r.key)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function MarketTab({ market, setMarket }) {
  const set = (k) => (v) => setMarket(m => ({ ...m, [k]: v }))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
      <Field label="City / Market Name" value={market.city} onChange={set('city')} />
      <Field label="Population" value={market.population} onChange={set('population')} />
      <Field label="Median Household Income" value={market.medianIncome} onChange={set('medianIncome')} />
      <Field label="Unemployment Rate" value={market.unemployment} onChange={set('unemployment')} />
      <Field label="Average Monthly Rent" value={market.avgRent} onChange={set('avgRent')} />
    </div>
  )
}

function PhotosTab({ photos, setPhotos }) {
  const onPhotoChange = (key, data) => setPhotos(p => ({ ...p, [key]: data }))
  const slots = [
    { key: 'exterior', label: 'Exterior (Cover Photo)' },
    { key: 'kitchen', label: 'Kitchen' },
    { key: 'living', label: 'Living Room' },
    { key: 'bathroom', label: 'Bathroom' },
    { key: 'kitchen2', label: 'Kitchen #2' },
    { key: 'wordmarkLogo', label: 'Wordmark Logo (PNG — maintain ratio)' },
    { key: 'circleLogo', label: 'Circle Badge Logo (PNG)' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
      {slots.map(s => (
        <PhotoSlot key={s.key} label={s.label} photoKey={s.key} photos={photos} onPhotoChange={onPhotoChange} />
      ))}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function OmPage() {
  const [tab, setTab] = useState(0)
  const [property, setProperty] = useState(DEFAULT_PROPERTY)
  const [agents, setAgents] = useState(DEFAULT_AGENTS)
  const [financials, setFinancials] = useState(DEFAULT_FINANCIALS)
  const [market, setMarket] = useState(DEFAULT_MARKET)
  const [photos, setPhotos] = useState({})
  const [generating, setGenerating] = useState(false)

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      await generateOM(property, agents, financials, market, photos)
      pushToast(`OM generated: Gateway_${property.name.replace(/\s+/g, '_')}_OM.pptx`)
    } catch (err) {
      console.error(err)
      pushToast('Failed to generate OM: ' + err.message, 'error')
    } finally {
      setGenerating(false)
    }
  }

  const uploadCount = Object.values(photos).filter(Boolean).length

  return (
    <div className="page-content">
      {/* Header */}
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div>
          <div className="page-title">OM Generator</div>
          <div className="page-sub">Offering Memorandum Builder</div>
        </div>
        <button
          className="btn btn-primary"
          onClick={handleGenerate}
          disabled={generating}
          style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 160 }}
        >
          {generating ? (
            <><Icon name="refresh" size={15} style={{ animation: 'spin 1s linear infinite' }} /> Building PPTX…</>
          ) : (
            <><Icon name="download" size={15} /> Generate OM</>
          )}
        </button>
      </div>

      {/* Preview summary bar */}
      <div style={{
        background: 'var(--gw-surface)',
        border: '1px solid var(--gw-border)',
        borderRadius: 'var(--radius)',
        padding: '12px 20px',
        marginTop: 16,
        marginBottom: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--gw-amber)' }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--gw-text)' }}>{property.name}</span>
        </div>
        {[
          { label: 'Asking', val: property.askingPrice },
          { label: 'Cap Rate', val: property.capRate },
          { label: 'Units', val: property.totalUnits },
          { label: 'Occupancy', val: property.occupancy },
          { label: 'NOI', val: property.noi },
          { label: 'Photos', val: `${uploadCount} uploaded` },
        ].map(({ label, val }) => (
          <div key={label} style={{ fontSize: 12, color: 'var(--gw-muted)' }}>
            <span style={{ fontWeight: 600, color: 'var(--gw-text)' }}>{val}</span>
            <span style={{ marginLeft: 4 }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Main card */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Tab nav */}
        <div style={{
          display: 'flex',
          borderBottom: '1px solid var(--gw-border)',
          background: 'var(--gw-surface)',
        }}>
          {TABS.map((t, i) => (
            <button
              key={t}
              onClick={() => setTab(i)}
              style={{
                padding: '12px 22px',
                fontSize: 13,
                fontWeight: tab === i ? 700 : 500,
                color: tab === i ? 'var(--gw-amber)' : 'var(--gw-muted)',
                background: 'transparent',
                border: 'none',
                borderBottom: tab === i ? '2px solid var(--gw-amber)' : '2px solid transparent',
                cursor: 'pointer',
                transition: 'color 0.15s',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ padding: '28px 28px 36px' }}>
          {tab === 0 && <PropertyTab property={property} setProperty={setProperty} />}
          {tab === 1 && <AgentsTab agents={agents} setAgents={setAgents} />}
          {tab === 2 && <FinancialsTab financials={financials} setFinancials={setFinancials} />}
          {tab === 3 && <MarketTab market={market} setMarket={setMarket} />}
          {tab === 4 && <PhotosTab photos={photos} setPhotos={setPhotos} />}
        </div>
      </div>

      {/* Bottom generate button */}
      <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--gw-muted)', alignSelf: 'center' }}>
          10-slide PPTX · Professional institutional design · Ready for PowerPoint
        </div>
        <button
          className="btn btn-primary"
          onClick={handleGenerate}
          disabled={generating}
          style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 160 }}
        >
          {generating ? (
            <><Icon name="refresh" size={15} style={{ animation: 'spin 1s linear infinite' }} /> Building PPTX…</>
          ) : (
            <><Icon name="download" size={15} /> Generate OM</>
          )}
        </button>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}

import React, { useState, useEffect } from 'react'

function LandingLoader() {
  return (
    <div style={{ minHeight:'100vh', background:'#f8f9fc', display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ color:'#9aa3b2', fontSize:14 }}>Loading…</div>
    </div>
  )
}

function LandingNotFound() {
  return (
    <div style={{ minHeight:'100vh', background:'#f8f9fc', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:32, textAlign:'center' }}>
      <div style={{ fontSize:48, marginBottom:16 }}>🏠</div>
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:24, color:'#1e2642', margin:'0 0 8px' }}>Campaign Not Found</h1>
      <p style={{ color:'#9aa3b2', fontSize:14 }}>This link may have expired or the campaign was removed.</p>
    </div>
  )
}

export default function CampaignLandingPage({ campaignId }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound,setNotFound]= useState(false)

  useEffect(() => {
    fetch(`/api/campaigns?action=get_campaign&campaign_id=${campaignId}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => {
        if (!d.campaign) { setNotFound(true); return }
        setData(d)
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [campaignId])

  if (loading)  return <LandingLoader />
  if (notFound) return <LandingNotFound />

  const { campaign, property, agent } = data

  const ctaHref = campaign.cta_button_url ||
    (agent?.phone ? `tel:${agent.phone.replace(/\D/g,'')}` : null) ||
    (agent?.email ? `mailto:${agent.email}` : null) ||
    '#'

  const fmt = n => n != null ? `$${Number(n).toLocaleString()}` : null

  return (
    <div style={{ minHeight:'100vh', background:'#f8f9fc', fontFamily:'system-ui,-apple-system,sans-serif' }}>
      {/* Hero */}
      <div style={{ background:'#1e2642', color:'#fff', padding:'48px 24px 40px', textAlign:'center' }}>
        <div style={{ fontSize:12, fontWeight:700, letterSpacing:'0.12em', textTransform:'uppercase', color:'#7b8ab8', marginBottom:16 }}>
          Gateway Real Estate Advisors
        </div>
        <h1 style={{ fontFamily:'Georgia,serif', fontSize:28, fontWeight:400, lineHeight:1.3, margin:'0 0 12px', color:'#fff' }}>
          {campaign.landing_headline || campaign.name}
        </h1>
        {campaign.landing_tagline && (
          <p style={{ fontSize:15, color:'#b0bbda', margin:'0 0 24px', lineHeight:1.5 }}>
            {campaign.landing_tagline}
          </p>
        )}
        <a href={ctaHref}
          style={{ display:'inline-block', background:'#4a6fa5', color:'#fff', padding:'14px 32px', borderRadius:8,
            fontSize:15, fontWeight:700, textDecoration:'none', letterSpacing:'0.02em' }}>
          {campaign.cta_button_text || 'Schedule a Call'}
        </a>
      </div>

      {/* Property details */}
      {property && (
        <div style={{ maxWidth:480, margin:'24px auto', padding:'0 16px' }}>
          <div style={{ background:'#fff', borderRadius:12, padding:'20px', border:'1px solid #e5e9f0' }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', color:'#9aa3b2', marginBottom:8 }}>
              Property Details
            </div>
            <div style={{ fontSize:16, fontWeight:700, color:'#1e2642', marginBottom:4 }}>
              {[property.address, property.city, property.state].filter(Boolean).join(', ')}
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'8px 16px', fontSize:13, color:'#4a6fa5', fontWeight:600, marginBottom: campaign.flyer_photo_caption ? 12 : 0 }}>
              {fmt(property.list_price) && <span>{fmt(property.list_price)}</span>}
              {property.type && <span style={{ textTransform:'capitalize' }}>{property.type}</span>}
              {property.beds  && <span>{property.beds} bd</span>}
              {property.baths && <span>{property.baths} ba</span>}
              {property.sqft  && <span>{Number(property.sqft).toLocaleString()} sqft</span>}
            </div>
            {campaign.flyer_photo_caption && (
              <div style={{ fontSize:12, color:'#9aa3b2', fontStyle:'italic', borderTop:'1px solid #f0f2f7', paddingTop:10 }}>
                {campaign.flyer_photo_caption}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Agent card */}
      {agent && (
        <div style={{ maxWidth:480, margin:'0 auto 24px', padding:'0 16px' }}>
          <div style={{ background:'#fff', borderRadius:12, padding:'20px', border:'1px solid #e5e9f0', display:'flex', alignItems:'center', gap:16 }}>
            <div style={{ width:48, height:48, borderRadius:'50%', background:'#4a6fa5', display:'flex', alignItems:'center', justifyContent:'center',
              color:'#fff', fontWeight:800, fontSize:18, flexShrink:0 }}>
              {agent.initials || agent.name?.slice(0,2).toUpperCase() || 'GW'}
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, color:'#1e2642', fontSize:15 }}>{agent.name}</div>
              {agent.phone && <div style={{ fontSize:13, color:'#4a6fa5', marginTop:2 }}><a href={`tel:${agent.phone.replace(/\D/g,'')}`} style={{ color:'#4a6fa5', textDecoration:'none' }}>{agent.phone}</a></div>}
              {agent.email && <div style={{ fontSize:13, color:'#9aa3b2', marginTop:1 }}><a href={`mailto:${agent.email}`} style={{ color:'#9aa3b2', textDecoration:'none' }}>{agent.email}</a></div>}
            </div>
            <a href={ctaHref}
              style={{ background:'#4a6fa5', color:'#fff', padding:'10px 18px', borderRadius:8, fontSize:13, fontWeight:700, textDecoration:'none', whiteSpace:'nowrap', flexShrink:0 }}>
              {campaign.cta_button_text || 'Contact'}
            </a>
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ textAlign:'center', padding:'16px 24px 32px', fontSize:11, color:'#c0c8d8' }}>
        Powered by Gateway CRM
      </div>
    </div>
  )
}

// The type-specific detail fields on the property form.

import React from 'react'

export function ResidentialFields({ form, set }) {
  return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Beds</label>
          <input className="form-control" type="number" value={form.beds||''} onChange={e=>set('beds',e.target.value)} placeholder="3" />
        </div>
        <div className="form-group">
          <label className="form-label">Baths</label>
          <input className="form-control" type="number" step="0.5" value={form.baths||''} onChange={e=>set('baths',e.target.value)} placeholder="2" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Sq Ft</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} placeholder="1,800" />
        </div>
        <div className="form-group">
          <label className="form-label">Garage</label>
          <select className="form-control" value={form.garage??0} onChange={e=>set('garage',Number(e.target.value))}>
            <option value={0}>No Garage</option>
            <option value={1}>1 Car</option>
            <option value={2}>2 Car</option>
            <option value={3}>3 Car</option>
            <option value={4}>4+ Car</option>
          </select>
        </div>
      </div>
    </>
  )
}

export function CommercialFields({ form, set }) {
  const d = form.details || {}
  const sd = (k, v) => set('details', { ...d, [k]: v })

  if (form.type === 'multifamily') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Total Units</label>
          <input className="form-control" type="number" value={d.total_units||''} onChange={e=>sd('total_units',e.target.value)} placeholder="24" />
        </div>
        <div className="form-group">
          <label className="form-label">Year Built</label>
          <input className="form-control" type="number" value={d.year_built||''} onChange={e=>sd('year_built',e.target.value)} placeholder="1998" />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Unit Mix</label>
        <input className="form-control" value={d.unit_mix||''} onChange={e=>sd('unit_mix',e.target.value)} placeholder="e.g. 10×Studio, 8×1BR, 6×2BR" />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Sq Ft (total)</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} placeholder="18,000" />
        </div>
        <div className="form-group">
          <label className="form-label">Parking Spaces</label>
          <input className="form-control" type="number" value={d.parking||''} onChange={e=>sd('parking',e.target.value)} />
        </div>
      </div>
    </>
  )

  if (form.type === 'office') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Sq Ft</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} placeholder="10,000" />
        </div>
        <div className="form-group">
          <label className="form-label">Floors</label>
          <input className="form-control" type="number" value={d.floors||''} onChange={e=>sd('floors',e.target.value)} placeholder="4" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Parking Spaces</label>
          <input className="form-control" type="number" value={d.parking||''} onChange={e=>sd('parking',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Year Built</label>
          <input className="form-control" type="number" value={d.year_built||''} onChange={e=>sd('year_built',e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Class</label>
          <select className="form-control" value={d.class||''} onChange={e=>sd('class',e.target.value)}>
            <option value="">—</option>
            <option value="A">Class A</option>
            <option value="B">Class B</option>
            <option value="C">Class C</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Vacancy Rate %</label>
          <input className="form-control" type="number" min="0" max="100" value={d.vacancy||''} onChange={e=>sd('vacancy',e.target.value)} />
        </div>
      </div>
    </>
  )

  if (form.type === 'land') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Acres</label>
          <input className="form-control" type="number" step="0.01" value={d.acres||''} onChange={e=>sd('acres',e.target.value)} placeholder="2.5" />
        </div>
        <div className="form-group">
          <label className="form-label">Sq Ft</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Status</label>
          <select className="form-control" value={d.land_status||''} onChange={e=>sd('land_status',e.target.value)}>
            <option value="">—</option>
            <option value="raw">Raw Land</option>
            <option value="developed">Developed</option>
            <option value="ready">Ready to Build</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Zoning</label>
          <input className="form-control" value={d.zoning||''} onChange={e=>sd('zoning',e.target.value)} placeholder="R-1, C-2, etc." />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Utilities Available</label>
        <input className="form-control" value={d.utilities||''} onChange={e=>sd('utilities',e.target.value)} placeholder="Water, Sewer, Electric, Gas" />
      </div>
    </>
  )

  if (form.type === 'retail') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Sq Ft</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} placeholder="5,000" />
        </div>
        <div className="form-group">
          <label className="form-label">Frontage (ft)</label>
          <input className="form-control" type="number" value={d.frontage||''} onChange={e=>sd('frontage',e.target.value)} placeholder="40" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Parking Spaces</label>
          <input className="form-control" type="number" value={d.parking||''} onChange={e=>sd('parking',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Year Built</label>
          <input className="form-control" type="number" value={d.year_built||''} onChange={e=>sd('year_built',e.target.value)} />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Anchor Tenants</label>
        <input className="form-control" value={d.anchor_tenants||''} onChange={e=>sd('anchor_tenants',e.target.value)} placeholder="Starbucks, Chase Bank…" />
      </div>
    </>
  )

  if (form.type === 'industrial') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Sq Ft</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} placeholder="50,000" />
        </div>
        <div className="form-group">
          <label className="form-label">Clear Height (ft)</label>
          <input className="form-control" type="number" value={d.clear_height||''} onChange={e=>sd('clear_height',e.target.value)} placeholder="28" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Loading Docks</label>
          <input className="form-control" type="number" value={d.loading_docks||''} onChange={e=>sd('loading_docks',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Drive-In Doors</label>
          <input className="form-control" type="number" value={d.drive_in_doors||''} onChange={e=>sd('drive_in_doors',e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Office Sq Ft</label>
          <input className="form-control" type="number" value={d.office_sqft||''} onChange={e=>sd('office_sqft',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Year Built</label>
          <input className="form-control" type="number" value={d.year_built||''} onChange={e=>sd('year_built',e.target.value)} />
        </div>
      </div>
    </>
  )

  if (form.type === 'mixed-use') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Total Units</label>
          <input className="form-control" type="number" value={d.total_units||''} onChange={e=>sd('total_units',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Floors</label>
          <input className="form-control" type="number" value={d.floors||''} onChange={e=>sd('floors',e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Residential Sq Ft</label>
          <input className="form-control" type="number" value={d.res_sqft||''} onChange={e=>sd('res_sqft',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Commercial Sq Ft</label>
          <input className="form-control" type="number" value={d.comm_sqft||''} onChange={e=>sd('comm_sqft',e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Year Built</label>
          <input className="form-control" type="number" value={d.year_built||''} onChange={e=>sd('year_built',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Parking Spaces</label>
          <input className="form-control" type="number" value={d.parking||''} onChange={e=>sd('parking',e.target.value)} />
        </div>
      </div>
    </>
  )

  return null
}

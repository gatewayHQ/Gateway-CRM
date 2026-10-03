// The state form packets an agent can download from the Documents tab.

import React from 'react'
import { fetchFormPacketsFor, formPacketStorage } from '../../lib/services/formPackets.js'
import { deliverPacket, packetFiles } from '../../lib/packetDownload.js'
import { Icon, pushToast } from '../../components/UI.jsx'

const TX_TYPE_LABELS = { buyer: 'Buyer Contract', seller: 'Listing / Seller', lease: 'Lease / Rental', general: 'General / Other' }

export function RequiredFormsPanel() {
  const [open, setOpen]           = React.useState(false)
  const [state, setState]         = React.useState('')
  const [txType, setTxType]       = React.useState('buyer')
  const [packets, setPackets]     = React.useState([])
  const [searching, setSearching] = React.useState(false)
  const [downloading, setDownloading] = React.useState({})

  const search = async () => {
    if (!state.trim()) { pushToast('Enter a state abbreviation', 'error'); return }
    setSearching(true)
    const { data } = await fetchFormPacketsFor(state.trim().toUpperCase(), txType)
    setPackets(data || [])
    setSearching(false)
  }

  // Delivers EVERY file in the packet. This used to sign `storage_path` alone —
  // the packet's first file — so a multi-file packet (purchase agreement + bill
  // of sale + disclosures) handed the agent one PDF and said nothing about the
  // rest. deliverPacket is the same code the Form Library's button runs.
  const downloadPacket = async (packet) => {
    if (!packetFiles(packet).length) { pushToast('No file uploaded for this packet yet', 'error'); return }
    setDownloading(p => ({ ...p, [packet.id]: true }))
    try {
      const { files, zipped } = await deliverPacket(packet, { storage: formPacketStorage() })
      if (zipped) pushToast(`Downloaded ${files} forms as a zip`, 'success')
    } catch (e) {
      pushToast(e.message, 'error')
    } finally {
      setDownloading(p => ({ ...p, [packet.id]: false }))
    }
  }

  return (
    <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', marginBottom: 14, background: '#fff', overflow: 'hidden' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', cursor: 'pointer', background: open ? 'var(--gw-bone)' : '#fff' }}
        onClick={() => setOpen(o => !o)}
      >
        <Icon name="document" size={15} style={{ color: 'var(--gw-azure)', flexShrink: 0 }} />
        <div style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>Required Forms</div>
        <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>Get state-specific form packets</div>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} style={{ color: 'var(--gw-mist)' }} />
      </div>
      {open && (
        <div style={{ borderTop: '1px solid var(--gw-border)', padding: '12px 12px 14px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <input
              className="form-control"
              style={{ width: 70, fontSize: 13, textTransform: 'uppercase' }}
              placeholder="State"
              maxLength={2}
              value={state}
              onChange={e => setState(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && search()}
            />
            <select className="form-control" style={{ fontSize: 13, flex: 1, minWidth: 140 }} value={txType} onChange={e => setTxType(e.target.value)}>
              {Object.entries(TX_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button className="btn btn--primary btn--sm" onClick={search} disabled={searching}>
              {searching ? 'Searching…' : 'Find Forms'}
            </button>
          </div>
          {packets.length === 0 && !searching && state && (
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', padding: '6px 0' }}>No packets found for {state} / {TX_TYPE_LABELS[txType]}. Ask your admin to upload one in the Form Library.</div>
          )}
          {packets.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--gw-bone)', borderRadius: 'var(--radius)', marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                {p.description && <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2 }}>{p.description}</div>}
              </div>
              <button className="btn btn--primary btn--sm" onClick={() => downloadPacket(p)} disabled={!packetFiles(p).length || downloading[p.id]}>
                <Icon name="download" size={12} /> {downloading[p.id] ? 'Opening…' : 'Get Forms'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

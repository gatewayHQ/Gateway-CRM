// The Signatures tab before anything has been sent.

import React from 'react'
import { Icon } from '../../../components/UI.jsx'
import { SIGNATURE_STEPS } from './signatureSteps.js'

export function SignaturesGettingStarted({ hasTemplates, templatesBroken, onTemplate, onUpload }) {
  return (
    <div style={{ maxWidth:520, margin:'12px auto 0', padding:'18px 20px', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', background:'#fff' }}>
      <div style={{ fontSize:15, fontWeight:700, color:'var(--gw-ink)', marginBottom:4 }}>Get a document signed</div>
      <div style={{ fontSize:12, color:'var(--gw-mist)', marginBottom:14 }}>Nothing has been sent on this deal yet. Here is how it works:</div>
      <ol style={{ listStyle:'none', margin:'0 0 16px', padding:0 }}>
        {SIGNATURE_STEPS.map(([title, body], i) => (
          <li key={title} style={{ display:'flex', gap:10, marginBottom:10 }}>
            <span style={{ width:22, height:22, borderRadius:'50%', background:'var(--gw-slate)', color:'#fff', fontSize:11, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{i + 1}</span>
            <span style={{ fontSize:12.5, lineHeight:1.5 }}>
              <strong style={{ color:'var(--gw-ink)' }}>{title}</strong>
              <span style={{ color:'var(--gw-mist)' }}> — {body}</span>
            </span>
          </li>
        ))}
      </ol>
      {hasTemplates ? (
        <button className="btn btn--primary" style={{ width:'100%', justifyContent:'center' }} onClick={onTemplate}>
          <Icon name="send" size={13}/> Start: Send from Template
        </button>
      ) : !templatesBroken && (
        <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:12, lineHeight:1.6 }}>
          <strong>No e-sign templates are set up yet.</strong> Ask your admin to set up the form you need for
          e-signature — or upload a PDF below in the meantime.
        </div>
      )}
      <div style={{ textAlign:'center', fontSize:12, color:'var(--gw-mist)', marginTop:12 }}>
        Already have the PDF?{' '}
        <button type="button" className="btn btn--link btn--sm" style={{ padding:0, fontSize:12 }} onClick={onUpload}>
          Upload your own PDF instead
        </button>
      </div>
    </div>
  )
}

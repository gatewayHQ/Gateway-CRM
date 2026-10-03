import React from 'react'
import MyEarnings from '../MyEarnings.jsx'
import { AdminBackOffice } from './AdminBackOffice.jsx'

// ── Main Page ─────────────────────────────────────────────────────────────────
// Back office (2026-06-12): admins get the full tracker + brokerage report +
// caps management; every other agent gets My Earnings — their own slice only.
export default function CommissionPage({ db, setDb, activeAgent, isAdmin, dealAgentIds }) {
  if (!isAdmin) return <MyEarnings activeAgent={activeAgent} />
  return <AdminBackOffice db={db} setDb={setDb} activeAgent={activeAgent} isAdmin={isAdmin} dealAgentIds={dealAgentIds} />
}

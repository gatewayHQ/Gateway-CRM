import React from 'react'
import { formatMoney } from '../lib/helpers.js'

// ── Where the money comes from ───────────────────────────────────────────────
// A small line under any commission figure: how much of it came from the
// seller side and how much from the buyer side. Every commission total in the
// CRM carries one, so an agent who represents both sides always sees the split,
// and the back office never has to work it out.
//
// `parts` is [{ party: 'seller' | 'buyer' | 'unsplit', amount }]. A figure that
// comes from one side only shows just that side's name. 'unsplit' is a
// both-sides deal whose commission was entered as one number, and says so.

const SHORT = { seller: 'Seller', buyer: 'Buyer', unsplit: 'Not split' }

export default function SideSplit({ parts, align = 'left', showAmounts = true }) {
  const list = (parts || []).filter(p => p && p.party)
  if (!list.length) return null
  const single = list.length === 1
  return (
    <div className={`side-split side-split--${align}`}>
      {list.map(p => (
        <span key={p.party} className={`side-split__part side-split__part--${p.party}`}
          title={p.party === 'unsplit' ? 'A both-sides deal entered as one total — enter each side on the deal’s Details tab to split it.' : undefined}>
          <span className="side-split__dot" aria-hidden="true" />
          {single ? (p.party === 'unsplit' ? 'Both sides · not split' : `${SHORT[p.party]} side`) : SHORT[p.party]}
          {showAmounts && !single && <strong>{formatMoney(p.amount)}</strong>}
        </span>
      ))}
    </div>
  )
}

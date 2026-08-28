// ─────────────────────────────────────────────────────────────────────────────
// boldsignSelections — the Selections panel's rows.
//
// WHAT THE PANEL IS. "Prepare Draft Agreement → Selections" is the SENDER's
// pre-check. One row is one checkbox already placed on the template, and the
// dropdown is the sender deciding what the packet goes out saying:
//
//   Checked    send the packet with this box ticked
//   Unchecked  send the packet with this box empty
//
// Either way the choice is locked onto the document before the signer ever sees
// it. These boxes are terms of the agreement — which representation, which
// party, which term length — and they are not the signer's to pick.
//
// WHERE A ROW'S NAME COMES FROM. Never the field id. `Checkbox1 p2 · CheckBox1`
// is BoldSign's auto-name in placement order and says nothing about what the box
// does; two boxes named `Checkbox1` can sit on different pages meaning different
// things. The name comes from the words printed beside the box on the page,
// captioned upstream by boldsignCaptions.js, and this module turns that printed
// caption into the short label the row shows.
//
// The rules below match on the PRINTED TEXT, so they hold for any template
// carrying the same clause, and a template whose wording is not recognized keeps
// its printed caption as the label rather than falling back to an id.
// ─────────────────────────────────────────────────────────────────────────────

// A checkbox's value as BoldSign reports it, in the several spellings it uses.
// Mirrors isCheckedValue in api/boldsign.js — anything not recognizably "on" is
// unticked, because a mark printed on a box the client did not agree to is the
// failure worth avoiding.
const CHECKED_VALUES = new Set(['true', 'on', 'yes', 'checked', '1', 'x'])
export function isTicked(v) {
  if (v === true) return true
  return CHECKED_VALUES.has(String(v ?? '').trim().toLowerCase())
}

// Printed caption → the short label a row shows, and the group it belongs to.
//
// ORDER MATTERS and is load bearing:
//   • "non-exclusive" must be tested before "exclusive", which is a substring
//     of it — the wrong order labels the non-exclusive box "Exclusive
//     representation", i.e. the exact opposite of the term being agreed.
//   • the policy clauses must be tested before the bare party words, because
//     "2. SINGLE BUYER AGENCY" contains "buyer" and is not the party box.
//
// `mutex` names a group in which only one box may be ticked at a time. It is
// asserted here, from the packet's rules, rather than read off the page: page 1
// prints "CHECK ALL BOXES THAT APPLY" above the representation pair, so the
// document does not state the XOR that a buyer packet requires.
export const SHORT_LABEL_RULES = [
  { re: /non-?\s?exclusive/i,                        label: 'Non-exclusive representation', mutex: 'representation' },
  { re: /\bexclusive\b/i,                            label: 'Exclusive representation',     mutex: 'representation' },

  { re: /single\s+seller\s+agency/i,                 label: 'Policy: Single Seller Agency' },
  { re: /single\s+buyer\s+agency/i,                  label: 'Policy: Single Buyer Agency' },
  { re: /consensual\s+dual\s+agency/i,               label: 'Policy: Consensual Dual Agency' },
  { re: /appointed\s+(seller|buyer)\s+agency/i,      label: 'Policy: Appointed Agency' },
  { re: /appointed\s+agency/i,                       label: 'Policy: Appointed Agency' },
  { re: /dual\s+agency/i,                            label: 'Policy: Dual Agency' },

  // Term of agreement. Matched on what the clause SAYS as well as its A/B
  // enumerator, so a template that numbers the pair differently still lands in
  // the right group — the wording ("continue until closing" vs "ends at 11:59
  // p.m.") is what distinguishes the two terms.
  { re: /ends?\s+at\s+11:?59|and\s+ends\s+at\b/i,    label: 'Term B: Fixed end date',            mutex: 'term' },
  { re: /continue\s+until\s+clos|until\s+closing\s+of\s+the\s+transaction/i,
                                                     label: 'Term A: Until close / completion',  mutex: 'term' },
  { re: /^B[.)]\s.*\bbegins\b/i,                     label: 'Term B: Fixed end date',            mutex: 'term' },
  { re: /^A[.)]\s.*\bbegins\b/i,                     label: 'Term A: Until close / completion',  mutex: 'term' },

  // The party words, only as a SHORT caption of their own. A long clause that
  // merely contains "buyer" is not the party box, and labelling it "Party:
  // Buyer" would name a policy row as the client's identity.
  { re: /^(prospective\s+)?buyer\b/i,                label: 'Party: Buyer',  mutex: 'party', maxLength: 24 },
  { re: /^(prospective\s+)?seller\b/i,               label: 'Party: Seller', mutex: 'party', maxLength: 24 },
]

// The short label for one printed caption, or null when no rule recognizes it.
export function shortLabelFor(caption) {
  const text = String(caption || '').trim()
  if (!text) return null
  for (const rule of SHORT_LABEL_RULES) {
    if (rule.maxLength && text.length > rule.maxLength) continue
    if (rule.re.test(text)) return { label: rule.label, mutex: rule.mutex || null }
  }
  return null
}

// One Selections row per tick box, in page then reading order — the order the
// boxes appear on the paper, which is the order the sender reads them in. What
// BoldSign returns is PLACEMENT order, which is neither.
//
// `title` is what the row shows. It is the short label where a rule matched, the
// printed caption where none did, and only for a box the page could not caption
// at all does the raw id survive — there is nothing else honest to show then,
// and inventing a name for a box that locks a term is the one thing this must
// never do.
export function selectionRows({ fields = [] } = {}) {
  const rows = (fields || [])
    .filter(f => f?.id)
    .map(f => {
      const caption = String(f.caption || '').trim()
      const match = shortLabelFor(caption)
      return {
        id: f.id,
        page: Number(f.page) || 1,
        caption,
        label: match?.label || caption || '',
        title: match?.label || caption || String(f.id),
        mutex: match?.mutex || null,
        named: Boolean(match?.label || caption),
        // What the template itself already carries. A box ticked on the template
        // defaults to Checked so the sender confirms it rather than silently
        // clearing a term the packet was authored with.
        defaultChecked: isTicked(f.value),
        y: Number(f.bounds?.y ?? 0),
        x: Number(f.bounds?.x ?? 0),
      }
    })
  return rows.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
}

// The starting value for every tick box: what the template already says.
// Two-state on purpose — every box goes out with a decision on it, because the
// sender is the one making these choices and an absent value would leave a term
// of the agreement to whoever opens the document.
export function seedSelectionValues(rows = []) {
  const out = {}
  for (const r of rows || []) out[r.id] = Boolean(r.defaultChecked)
  return out
}

// Apply one row's new state, enforcing its mutex group: ticking Exclusive
// unticks Non-exclusive, ticking Term A unticks Term B. Unticking a box never
// ticks anything — clearing both is a valid intermediate state, and picking the
// other one for the sender would be this panel deciding a term of the agreement
// on their behalf.
export function applySelection(values = {}, rows = [], id, checked) {
  const next = { ...values, [id]: Boolean(checked) }
  if (!checked) return next
  const row = (rows || []).find(r => r.id === id)
  if (!row?.mutex) return next
  for (const other of rows) {
    if (other.id !== id && other.mutex === row.mutex) next[other.id] = false
  }
  return next
}

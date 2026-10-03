// Constants shared by the signature screens.

// Per-signer accent colors for multi-signer field placement
export const SIGNER_COLORS = ['#2563eb','#d97706','#dc2626','#0891b2']

// ── First-visit guide for the Signatures tab ────────────────────────────────
// What an empty tab shows. A new agent arrives here not knowing that e-sign
// forms start on the deal, that they fill in from it, or that nothing goes out
// until they say so — so the whole route is laid out as three steps with the
// button for step one under it. When the deal has no sendable template, it
// says why and who fixes it rather than leaving a button missing.
export const SIGNATURE_STEPS = [
  ['Pick a template', 'Choose the e-sign form for your state. Deal, client and property details fill in automatically.'],
  ['Review the draft', 'See exactly what your signers will get. Move or add signature boxes if this deal needs it. Nothing is sent yet.'],
  ['Send for signature', 'Confirm who gets it. Each signer is emailed a link, and this tab updates as they sign.'],
]

// The eyebrow each screen of the template route wears, so an agent always
// knows how far they are from sending.
export const templateStep = (n) => `Send from Template · Step ${n} of ${SIGNATURE_STEPS.length}`

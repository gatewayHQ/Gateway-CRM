// ─────────────────────────────────────────────────────────────────────────────
// Controlled-vocabulary enums — the single source of truth for the values the
// database CHECK constraints enforce (see src/lib/schema.sql).
//
// These lists used to be copy-pasted as ad-hoc arrays into ~7 components
// (contact/property forms, list filters, CSV import, cold-call intake, reports).
// When one copy gained a value the others — or the database constraint — didn't,
// inserts failed with a raw "violates check constraint" error, and reports
// silently dropped buckets (Reports.jsx had quietly lost 'team' / 'paid service').
//
// Define each enum here ONCE. `scripts/check-enums.mjs` (run in CI) parses
// schema.sql and fails the build if any list below offers a value the matching
// database constraint would reject — so a form can never again ship a value the
// database refuses.
// ─────────────────────────────────────────────────────────────────────────────

// Default Title-case label, matching the historical
// `s.charAt(0).toUpperCase() + s.slice(1)` rendering used across the forms.
export const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1)

// ── Contacts ─────────────────────────────────────────────────────────────────
// Mirror of contacts.{type,status,source} CHECK constraints in schema.sql.
export const CONTACT_TYPES    = ['buyer', 'seller', 'landlord', 'tenant', 'investor']
export const CONTACT_STATUSES = ['lead', 'opportunity', 'active', 'pending', 'cold', 'closed']
export const CONTACT_SOURCES  = ['referral', 'website', 'open house', 'social', 'cold call', 'team', 'paid service', 'other']

// ── Properties ───────────────────────────────────────────────────────────────
// Property type is presented grouped (Residential vs Commercial) and a couple of
// labels are customised, so the labels live in an explicit map alongside the
// values. The forms surface the grouped lists; `PROPERTY_TYPES` is the full set
// the database accepts — it also includes the generic 'commercial' bucket used by
// imports and legacy rows but never offered in the form.
export const RESIDENTIAL_PROPERTY_TYPES = ['residential', 'rental']
export const COMMERCIAL_PROPERTY_TYPES  = ['multifamily', 'office', 'land', 'retail', 'industrial', 'mixed-use']
export const PROPERTY_TYPES = [...RESIDENTIAL_PROPERTY_TYPES, ...COMMERCIAL_PROPERTY_TYPES, 'commercial']

export const PROPERTY_TYPE_LABELS = {
  residential: 'Residential',
  rental:      'Rental (Residential)',
  multifamily: 'Multifamily',
  office:      'Office',
  land:        'Land',
  retail:      'Retail',
  industrial:  'Industrial',
  'mixed-use': 'Mixed-Use',
}

// Statuses offered by the property form/filters. The database also allows
// 'cancelled' (set by dragging in the pipeline, not the form), so this is a
// subset of the constraint — see scripts/check-enums.mjs.
export const PROPERTY_STATUSES = ['active', 'pending', 'sold', 'off-market', 'leased']

// True when a property type belongs to the residential family — drives
// residential-vs-commercial branching in the pipeline and matching.
export const isResidentialPropertyType = (t) => RESIDENTIAL_PROPERTY_TYPES.includes(t)

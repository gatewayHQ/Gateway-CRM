// Property type groupings and labels.

import { COMMERCIAL_PROPERTY_TYPES } from '../../lib/enums.js'

// Types where commercial fields apply
export const COMMERCIAL_TYPES = COMMERCIAL_PROPERTY_TYPES

export const isCommercial = (t) => COMMERCIAL_TYPES.includes(t)

export const TYPE_LABELS = {
  residential: 'Residential',
  multifamily: 'Multifamily',
  office: 'Office',
  land: 'Land',
  retail: 'Retail',
  industrial: 'Industrial',
  'mixed-use': 'Mixed-Use',
  rental: 'Rental (Residential)',
}

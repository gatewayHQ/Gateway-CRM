import { describe, it, expect } from 'vitest'
import {
  CONTACT_TYPES, CONTACT_STATUSES, CONTACT_SOURCES,
  PROPERTY_TYPES, PROPERTY_STATUSES,
  RESIDENTIAL_PROPERTY_TYPES, COMMERCIAL_PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS, isResidentialPropertyType, titleCase,
} from '../enums.js'

const noDuplicates = (arr) => new Set(arr).size === arr.length

describe('enum lists', () => {
  it('contain no duplicate values', () => {
    for (const list of [CONTACT_TYPES, CONTACT_STATUSES, CONTACT_SOURCES, PROPERTY_TYPES, PROPERTY_STATUSES]) {
      expect(noDuplicates(list)).toBe(true)
    }
  })

  it('include the values that previously broke inserts', () => {
    expect(CONTACT_STATUSES).toContain('opportunity')
    expect(CONTACT_SOURCES).toContain('cold call')
    // Reports.jsx had silently dropped these two — guard against regressing.
    expect(CONTACT_SOURCES).toContain('team')
    expect(CONTACT_SOURCES).toContain('paid service')
  })

  it('builds PROPERTY_TYPES from the grouped lists plus the generic bucket', () => {
    expect(PROPERTY_TYPES).toEqual([...RESIDENTIAL_PROPERTY_TYPES, ...COMMERCIAL_PROPERTY_TYPES, 'commercial'])
  })

  it('has a label for every form-facing property type', () => {
    for (const t of [...RESIDENTIAL_PROPERTY_TYPES, ...COMMERCIAL_PROPERTY_TYPES]) {
      expect(PROPERTY_TYPE_LABELS[t]).toBeTruthy()
    }
  })

  it('classifies residential vs commercial types correctly', () => {
    expect(isResidentialPropertyType('rental')).toBe(true)
    expect(isResidentialPropertyType('residential')).toBe(true)
    expect(isResidentialPropertyType('office')).toBe(false)
    expect(isResidentialPropertyType('multifamily')).toBe(false)
  })
})

describe('titleCase', () => {
  it('capitalizes the first letter, matching the historical form rendering', () => {
    expect(titleCase('opportunity')).toBe('Opportunity')
    expect(titleCase('cold call')).toBe('Cold call')
    expect(titleCase('paid service')).toBe('Paid service')
  })
})

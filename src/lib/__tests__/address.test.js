// Property addresses with a suite / unit (migration 0042).
//
// The rules under test are the ones a leasing agent notices: a bare "200" is a
// suite number, a suite already written out is left alone, the suite shows up
// everywhere the address does — and it never reaches a geocoder.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  normalizeUnit, propertyUnit, streetLine, fullAddress, cityStateLine,
  geocodeQuery, propertyLabel, isMissingUnitColumn, readPropertiesWithUnit,
} from '../address.js'
import { filterProperties, propertyLine } from '../search.js'
import { fullAddress as announcementAddress } from '../dealAnnouncement.js'
import { crmTokenValues } from '../services/boldsignFields.js'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const SUITE = {
  id: 'p1', address: '2212 Okoboji Ave', unit: 'Suite 120',
  city: 'Milford', state: 'IA', zip: '51351',
}
const WHOLE_BUILDING = { id: 'p2', address: '1200 Grand Ave', city: 'Des Moines', state: 'IA', zip: '50309' }

describe('normalizeUnit', () => {
  it('reads a bare number as a suite number', () => {
    expect(normalizeUnit('200')).toBe('Suite 200')
    expect(normalizeUnit('  2B ')).toBe('Suite 2B')
  })

  it('leaves an already-labelled unit as the agent wrote it', () => {
    expect(normalizeUnit('Suite 120')).toBe('Suite 120')
    expect(normalizeUnit('ste 4')).toBe('ste 4')
    expect(normalizeUnit('Unit B')).toBe('Unit B')
    expect(normalizeUnit('Bldg C')).toBe('Bldg C')
    expect(normalizeUnit('Space 7')).toBe('Space 7')
  })

  it('tidies punctuation and whitespace', () => {
    expect(normalizeUnit('#  12')).toBe('#12')
    expect(normalizeUnit(', 3B')).toBe('Suite 3B')
    expect(normalizeUnit('Suite   200')).toBe('Suite 200')
  })

  it('stores nothing for an empty or punctuation-only field', () => {
    expect(normalizeUnit('')).toBe('')
    expect(normalizeUnit('   ')).toBe('')
    expect(normalizeUnit('—')).toBe('')
    expect(normalizeUnit(null)).toBe('')
    expect(normalizeUnit(undefined)).toBe('')
  })

  it('normalizes what a row already holds', () => {
    expect(propertyUnit({ unit: '120' })).toBe('Suite 120')
    expect(propertyUnit(WHOLE_BUILDING)).toBe('')
    expect(propertyUnit(null)).toBe('')
  })
})

describe('composing an address', () => {
  it('puts the suite on the street line', () => {
    expect(streetLine(SUITE)).toBe('2212 Okoboji Ave, Suite 120')
    expect(fullAddress(SUITE)).toBe('2212 Okoboji Ave, Suite 120, Milford, IA, 51351')
  })

  it('reads exactly as before for a listing with no suite', () => {
    expect(streetLine(WHOLE_BUILDING)).toBe('1200 Grand Ave')
    expect(fullAddress(WHOLE_BUILDING)).toBe('1200 Grand Ave, Des Moines, IA, 50309')
    expect(fullAddress({ address: '5 Elm St' })).toBe('5 Elm St')
  })

  it('survives partial and missing rows', () => {
    expect(streetLine(null)).toBe('')
    expect(fullAddress(null)).toBe('')
    expect(streetLine({ unit: 'Suite 3' })).toBe('Suite 3')
    expect(cityStateLine(SUITE)).toBe('Milford, IA')
  })

  it('labels a picker row with the suite', () => {
    expect(propertyLabel(SUITE)).toBe('2212 Okoboji Ave, Suite 120 · Milford, IA')
    expect(propertyLabel(WHOLE_BUILDING)).toBe('1200 Grand Ave · Des Moines, IA')
  })
})

describe('geocoding', () => {
  it('omits the suite — geocoders resolve buildings, not spaces inside them', () => {
    expect(geocodeQuery(SUITE)).toBe('2212 Okoboji Ave, Milford, IA, 51351')
    expect(geocodeQuery(SUITE)).not.toMatch(/Suite/)
    expect(geocodeQuery(null)).toBe('')
  })

  it('is what the pages that hit a geocoder or a map actually call', () => {
    for (const rel of ['../../pages/Properties.jsx', '../../pages/Integrations.jsx']) {
      const src = read(rel)
      expect(src).toMatch(/geocodeQuery\(/)
      // No hand-rolled join feeding nominatim/maps — that is how the suite leaks in.
      expect(src).not.toMatch(/\[form\.address, form\.city, form\.state, form\.zip\]/)
      expect(src).not.toMatch(/\[p\.address, p\.city, p\.state, p\.zip\]/)
    }
  })
})

describe('search sees the suite', () => {
  const rows = [SUITE, WHOLE_BUILDING]

  it('matches the suite on its own and as part of the street line', () => {
    expect(filterProperties(rows, 'suite 120').map(p => p.id)).toEqual(['p1'])
    // "okoboji ave, suite" only matches once the two columns are composed —
    // neither `address` nor `unit` contains it on its own.
    expect(filterProperties(rows, 'okoboji ave, suite').map(p => p.id)).toEqual(['p1'])
    expect(filterProperties(rows, 'grand').map(p => p.id)).toEqual(['p2'])
  })

  it('labels results with the suite', () => {
    expect(propertyLine(SUITE)).toBe('2212 Okoboji Ave, Suite 120 · Milford, IA')
  })

  it('the database function matches it too, so the RPC agrees with the fallback', () => {
    const schema = read('../schema.sql')
    const searchFn = schema.slice(schema.indexOf('function search_properties'))
      .slice(0, schema.slice(schema.indexOf('function search_properties')).indexOf('$$;'))
    expect(searchFn).toMatch(/unit/)
  })
})

describe('everything downstream of the property gets the suite', () => {
  it('announcement emails address the space, not the building', () => {
    expect(announcementAddress(SUITE)).toBe('2212 Okoboji Ave, Suite 120, Milford, IA, 51351')
  })

  it('document tokens carry the composed street line and the suite alone', () => {
    const vals = crmTokenValues({ property: SUITE })
    expect(vals.property_address).toBe('2212 Okoboji Ave, Suite 120')
    expect(vals.property_unit).toBe('Suite 120')
    expect(vals.property_full).toBe('2212 Okoboji Ave, Suite 120, Milford, IA, 51351')
  })

  it('a listing with no suite prints what it always did', () => {
    const vals = crmTokenValues({ property: WHOLE_BUILDING })
    expect(vals.property_address).toBe('1200 Grand Ave')
    expect(vals.property_unit).toBe('')
  })
})

describe('a database without migration 0042', () => {
  it('recognizes the unknown-column failure, and only that one', () => {
    expect(isMissingUnitColumn({ message: 'column properties.unit does not exist' })).toBe(true)
    expect(isMissingUnitColumn({ message: "Could not find the 'unit' column of 'properties' in the schema cache" })).toBe(true)
    expect(isMissingUnitColumn({ message: 'permission denied for table properties' })).toBe(false)
    expect(isMissingUnitColumn({ message: 'column properties.unit_count does not exist' })).toBe(false)
    expect(isMissingUnitColumn(null)).toBe(false)
  })

  it('re-reads without the column instead of returning nothing', async () => {
    const asked = []
    const run = (cols) => {
      asked.push(cols)
      return Promise.resolve(cols.includes('unit')
        ? { data: null, error: { message: 'column properties.unit does not exist' } }
        : { data: [{ id: 'p1', address: '2212 Okoboji Ave' }], error: null })
    }
    const res = await readPropertiesWithUnit('id, address', run)
    expect(asked).toEqual(['id, address, unit', 'id, address'])
    expect(res.data).toEqual([{ id: 'p1', address: '2212 Okoboji Ave' }])
  })

  it('does not re-read when the first read worked', async () => {
    const asked = []
    const res = await readPropertiesWithUnit('id, address', (cols) => {
      asked.push(cols)
      return Promise.resolve({ data: [SUITE], error: null })
    })
    expect(asked).toEqual(['id, address, unit'])
    expect(res.data).toEqual([SUITE])
  })

  it('passes a real error through untouched', async () => {
    const err = { message: 'permission denied for table properties' }
    const res = await readPropertiesWithUnit('id, address', () => Promise.resolve({ data: null, error: err }))
    expect(res.error).toBe(err)
  })

  it('lets the property drawer save without the suite rather than failing', () => {
    const src = read('../../pages/Properties.jsx')
    expect(src).toMatch(/isMissingUnitColumn\(error\)/)
    expect(src).toMatch(/migration 0042/)
  })
})

describe('the suite is a real column, not a detail-blob field', () => {
  it('is declared on properties and shipped as a migration', () => {
    expect(read('../schema.sql')).toMatch(/^ {2}unit {14}text,$/m)
    expect(read('../../../migrations/0042_property_suite_unit.sql'))
      .toMatch(/alter table properties add column if not exists unit text;/)
  })

  it('is on the public listing page projection', () => {
    expect(read('../../../api/property-public.js')).toMatch(/'id', 'address', 'unit', 'city'/)
  })
})

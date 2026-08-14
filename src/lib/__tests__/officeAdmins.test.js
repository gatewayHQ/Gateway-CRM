// ─────────────────────────────────────────────────────────────────────────────
// The office-admin allow-list.
//
// Two rules are load-bearing and easy to break by accident:
//   1. Only Erin and Daniel may see/toggle the switch — every other account,
//      admin or not, gets `false` from canHoldOfficeAdmin.
//   2. For those two accounts an explicit is_admin=false is FINAL. The legacy
//      role-string fallback must not quietly hand firm-wide visibility back to
//      someone who just turned it off, or the toggle is decorative.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { canHoldOfficeAdmin, isOfficeAdmin, OFFICE_ADMIN_ACCOUNTS } from '../officeAdmins.js'

const ERIN   = { id: 'a-erin', email: 'erin@gatewayreadvisors.com',   role: 'Broker' }
const DANIEL = { id: 'a-dan',  email: 'daniel@gatewayreadvisors.com', role: 'Advisor' }
const NIC    = { id: 'a-nic',  email: 'nic@gatewayreadvisors.com',    role: 'Advisor' }

describe('canHoldOfficeAdmin', () => {
  it('covers exactly the broker and the builder', () => {
    expect(OFFICE_ADMIN_ACCOUNTS).toHaveLength(2)
    expect(canHoldOfficeAdmin(ERIN)).toBe(true)
    expect(canHoldOfficeAdmin(DANIEL)).toBe(true)
  })

  it('says no to every other agent — including one who is already an admin', () => {
    expect(canHoldOfficeAdmin(NIC)).toBe(false)
    expect(canHoldOfficeAdmin({ ...NIC, is_admin: true, role: 'Office Admin' })).toBe(false)
  })

  it('ignores case and stray whitespace on the stored email', () => {
    expect(canHoldOfficeAdmin('  Erin@GatewayREAdvisors.com ')).toBe(true)
  })

  it('never matches a missing, blank, or malformed email', () => {
    expect(canHoldOfficeAdmin(null)).toBe(false)
    expect(canHoldOfficeAdmin({})).toBe(false)
    expect(canHoldOfficeAdmin('')).toBe(false)
    expect(canHoldOfficeAdmin('erin@gatewayreadvisors.com.attacker.io')).toBe(false)
  })
})

describe('isOfficeAdmin', () => {
  it('honors the explicit flag', () => {
    expect(isOfficeAdmin({ ...ERIN, is_admin: true })).toBe(true)
    expect(isOfficeAdmin({ ...NIC,  is_admin: true })).toBe(true)
    expect(isOfficeAdmin({ ...NIC,  is_admin: false })).toBe(false)
  })

  it('drops an allow-listed account to agent level the moment the toggle is off', () => {
    // Role text that mentions "admin" must NOT keep the door open for them.
    expect(isOfficeAdmin({ ...ERIN, is_admin: false, role: 'Broker / Office Admin' })).toBe(false)
    expect(isOfficeAdmin({ ...DANIEL, is_admin: null, role: 'Admin' })).toBe(false)
  })

  it('keeps the legacy role fallback for everyone else (pre-migration-0005 rows)', () => {
    expect(isOfficeAdmin({ ...NIC, role: 'Office Admin' })).toBe(true)
    expect(isOfficeAdmin({ ...NIC, role: 'Transaction Coordinator' })).toBe(false)
  })

  it('handles a missing agent', () => {
    expect(isOfficeAdmin(null)).toBe(false)
    expect(isOfficeAdmin(undefined)).toBe(false)
  })
})

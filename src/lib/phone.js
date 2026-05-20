/**
 * Phone number normalization & formatting.
 *
 * Storage rule: always E.164 (e.g. "+15555550100") — required for Twilio.
 * Display rule: human-friendly per locale (currently US-centric).
 */

/**
 * Normalize any phone input to E.164.
 * Returns null if it can't be parsed (caller should validate).
 *
 * Accepts:
 *   "(555) 555-0100"
 *   "555.555.0100"
 *   "5555550100"
 *   "+1 555 555 0100"
 *   "1-555-555-0100"
 */
export function normalizePhone(input, defaultCountry = '1') {
  if (!input) return null
  const raw = String(input).trim()
  if (!raw) return null

  // Strip everything except digits and leading +
  const hasPlus = raw.startsWith('+')
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null

  // Already has country code (international)
  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) return null
    return `+${digits}`
  }

  // US/Canada: 10 digits → prepend +1
  if (digits.length === 10) return `+${defaultCountry}${digits}`
  // 11 digits starting with 1 → already has country code
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`

  // Otherwise we don't know — return null so caller can decide
  return null
}

/**
 * Format E.164 (or any input) for display.
 * "+15555550100" → "(555) 555-0100"
 * Falls back to the raw input if unparseable.
 */
export function formatPhone(input) {
  if (!input) return ''
  const digits = String(input).replace(/\D/g, '')

  // US/Canada
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }

  // International — group with spaces
  if (digits.length > 10) {
    return `+${digits.slice(0, digits.length - 10)} ${digits.slice(-10, -7)} ${digits.slice(-7, -4)} ${digits.slice(-4)}`
  }

  return String(input)
}

/**
 * Returns true if the string looks like a valid phone we can normalize.
 */
export function isValidPhone(input) {
  return normalizePhone(input) !== null
}

/**
 * Field-level validators for forms.
 * Each returns { valid: bool, error: string|null }.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function validateEmail(value, { required = false } = {}) {
  const v = (value || '').trim()
  if (!v) return required ? { valid: false, error: 'Email is required' } : { valid: true, error: null }
  if (!EMAIL_RE.test(v)) return { valid: false, error: 'Invalid email format' }
  return { valid: true, error: null }
}

export function validateRequired(value, label = 'This field') {
  const v = typeof value === 'string' ? value.trim() : value
  if (!v) return { valid: false, error: `${label} is required` }
  return { valid: true, error: null }
}

/**
 * The agent-set compensation on a deal: EITHER a commission rate (%) OR a flat
 * fee ($) — never both. `type` decides which amount is read, so the other one
 * is ignored entirely (that's what makes the two options mutually exclusive).
 *
 *   validateAgentComp({ type: 'rate', rate_pct: '3' })      → valid
 *   validateAgentComp({ type: 'flat', flat: '' })           → "Flat fee is required"
 *   validateAgentComp({ type: 'rate', rate_pct: '120' })    → out of range
 *
 * `required: false` accepts a completely empty entry (legacy deals that predate
 * the field, where the office still prices the transaction by hand).
 */
export function validateAgentComp({ type, rate_pct, flat } = {}, { required = true } = {}) {
  const raw   = type === 'flat' ? flat : rate_pct
  const empty = raw === '' || raw === null || raw === undefined
  const label = type === 'flat' ? 'Flat fee' : 'Commission rate'

  if (empty) {
    return required
      ? { valid: false, error: `${label} is required` }
      : { valid: true, error: null }
  }
  if (type !== 'rate' && type !== 'flat') {
    return { valid: false, error: 'Choose a commission rate or a flat fee' }
  }

  const n = Number(raw)
  if (!Number.isFinite(n))       return { valid: false, error: `${label} must be a number` }
  if (n <= 0)                    return { valid: false, error: `${label} must be greater than 0` }
  if (type === 'rate' && n > 100) return { valid: false, error: 'Commission rate must be between 0 and 100%' }

  return { valid: true, error: null }
}

/**
 * Run multiple validators, return { valid, errors: Record<field, error> }.
 *   const result = validateForm(form, {
 *     first_name: [v => validateRequired(v, 'First name')],
 *     email:      [v => validateEmail(v, { required: false })],
 *   })
 */
export function validateForm(form, rules) {
  const errors = {}
  for (const [field, validators] of Object.entries(rules)) {
    for (const validator of validators) {
      const result = validator(form[field])
      if (!result.valid) {
        errors[field] = result.error
        break
      }
    }
  }
  return { valid: Object.keys(errors).length === 0, errors }
}

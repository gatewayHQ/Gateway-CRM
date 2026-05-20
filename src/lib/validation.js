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

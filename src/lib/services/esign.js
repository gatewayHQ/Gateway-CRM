// ─────────────────────────────────────────────────────────────────────────────
// E-signature client — thin wrapper around POST /api/boldsign.
//
// Centralizes the auth-header dance (every action requires a session Bearer
// token server-side) so UI components don't each re-implement it. All calls
// return { ok, ...payload } or { ok: false, error } — no throws.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

async function callEsign(action, params = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) return { ok: false, error: 'Sign in required' }

  let res
  try {
    res = await fetch('/api/boldsign', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body:    JSON.stringify({ action, ...params }),
    })
  } catch (e) {
    return { ok: false, error: `Network error: ${e.message}` }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body?.error) return { ok: false, error: body?.error || `HTTP ${res.status}` }
  return { ok: true, ...body }
}

/** Org-level reusable templates. Returns { ok, templates: [{id, name, description}] }. */
export function listEsignTemplates() {
  return callEsign('templates')
}

/** Roles + pre-fillable fields for one template (drives per-send customization). */
export function getEsignTemplateFields(templateId) {
  return callEsign('template-fields', { templateId })
}

/**
 * Send directly from a template — no editor hop.
 * roles: [{ roleIndex, name, email, order?, existingFields?: [{id, value}] }]
 */
export function sendEsignFromTemplate({ templateId, roles, documentTitle, emailSubject, message }) {
  return callEsign('send-template', { templateId, roles, documentTitle, emailSubject, message })
}

/**
 * Upload path: create the request and get BoldSign's prepare-page URL where
 * the agent places fields and clicks Send. Returns { ok, documentId, prepareUrl }.
 */
export function sendEsignForPrep({ signers, documentBase64, documentName, emailSubject }) {
  return callEsign('send', { signers, documentBase64, documentName, emailSubject })
}

/** Poll current status. Returns { ok, status, signerStatus, completedDateTime }. */
export function getEsignStatus(documentId) {
  return callEsign('status', { documentId })
}

/** Signed PDF as base64. Returns { ok, base64, contentType }. */
export function downloadEsignPdf(documentId) {
  return callEsign('download', { documentId })
}

/** Nudge all pending signers. */
export function remindEsignSigners(documentId) {
  return callEsign('remind', { documentId })
}

/** Void an in-flight request (e.g. wrong signer, expired flow restart). */
export function revokeEsignDocument(documentId, reason) {
  return callEsign('revoke', { documentId, reason })
}

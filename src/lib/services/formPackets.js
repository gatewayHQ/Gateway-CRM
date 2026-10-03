// ─────────────────────────────────────────────────────────────────────────────
// Form packets — the `form_packets` table and the `form-packets` storage bucket
// that holds each packet's PDFs.
//
// Used by the Form Library (admin CRUD + uploads for the BoldSign template
// editor) and the deal Documents tab's Required Forms panel (lookup +
// download). The closing-gate query lives in requiredForms.js.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

export const FORM_PACKET_BUCKET = 'form-packets'

// ── form_packets rows ────────────────────────────────────────────────────────

export const fetchFormPackets = () =>
  supabase.from('form_packets').select('*').order('state').order('transaction_type')

export const fetchFormPacketsFor = (state, transactionType) =>
  supabase.from('form_packets').select('*')
    .eq('state', state).eq('transaction_type', transactionType)

export const insertFormPacket = (packet) =>
  supabase.from('form_packets').insert([packet]).select()

export const updateFormPacket = (id, fields) =>
  supabase.from('form_packets').update(fields).eq('id', id).select()

export const deleteFormPacket = (id) =>
  supabase.from('form_packets').delete().eq('id', id)

// ── form-packets bucket ──────────────────────────────────────────────────────

// The bucket handle deliverPacket() lists / signs / downloads through.
export const formPacketStorage = () => supabase.storage.from(FORM_PACKET_BUCKET)

export const uploadFormPacketFile = (path, file) =>
  supabase.storage.from(FORM_PACKET_BUCKET).upload(path, file, {
    upsert: true, contentType: 'application/pdf',
  })

export const createFormPacketSignedUrl = (path, expiresIn) =>
  supabase.storage.from(FORM_PACKET_BUCKET).createSignedUrl(path, expiresIn)

/** Form Library entries that can be sent from a template, by name. */
export const fetchSendableFormPackets = (columns) =>
  supabase
    .from('form_packets')
    .select(columns)
    .not('boldsign_template_id', 'is', null)
    .eq('active', true)
    .order('name')

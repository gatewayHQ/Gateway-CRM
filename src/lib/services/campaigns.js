// ─────────────────────────────────────────────────────────────────────────────
// Campaigns service — mailing images and the mailing contact picker.
//
// Campaign rows themselves go through /api/campaigns (service key, server-side
// scoping). What the Campaigns and Mass Email pages read or write with the
// browser client lives here: the campaign-images bucket, and the contacts list
// the mailing builder picks recipients from.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { IMMUTABLE_CACHE } from '../imageCompress.js'

// ── campaign-images storage ──────────────────────────────────────────────────

/** Upload an already-compressed image to campaign-images at `path`. Never overwrites. */
export const uploadCampaignImage = (path, blob, contentType) =>
  supabase.storage.from('campaign-images')
    .upload(path, blob, { contentType, upsert: false, cacheControl: IMMUTABLE_CACHE })

/** The public URL for a campaign-images path (synchronous; no request). */
export const getCampaignImagePublicUrl = (path) =>
  supabase.storage.from('campaign-images').getPublicUrl(path)

// ── contacts ─────────────────────────────────────────────────────────────────

/** Contacts with the owner mailing address, for picking mailing recipients. */
export const fetchMailingContacts = () =>
  supabase.from('contacts').select('id, first_name, last_name, email, phone, owner_address, owner_city, owner_state, owner_zip').order('last_name')

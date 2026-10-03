// Image upload and field-label helpers shared by the landing builders.

import { uploadCampaignImage, getCampaignImagePublicUrl } from '../../../lib/services/campaigns.js'
import { compressForUpload } from '../../../lib/imageCompress.js'

// ─── Shared image-upload helper ──────────────────────────────────────────────

export async function uploadImageToStorage(file, setUploading, idx) {
  setUploading(u => ({ ...u, [idx]: true }))
  try {
    const { blob, ext, type } = await compressForUpload(file, 'landing')
    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error: upErr } = await uploadCampaignImage(path, blob, type)
    if (upErr) throw upErr
    const { data: { publicUrl } } = getCampaignImagePublicUrl(path)
    return publicUrl
  } finally {
    setUploading(u => { const n = { ...u }; delete n[idx]; return n })
  }
}

export const normImg = v => typeof v === 'string' || !v
  ? { url: v || '', units: '', price: '', caption: '' }
  : { url: v.url || '', units: v.units || '', price: v.price || '', caption: v.caption || '' }

export const fieldLabel = { fontSize: 11, fontWeight: 700, color: 'var(--gw-ink)', textTransform: 'uppercase', letterSpacing: 0.5 }

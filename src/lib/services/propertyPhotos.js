// A property's photos in the `property-photos` storage bucket: upload, public
// URL, remove. The photo URLs themselves live on the property row.

import { supabase } from '../supabase.js'

export const uploadPropertyPhoto = (path, blob, options) =>
  supabase.storage.from('property-photos').upload(path, blob, options)

export const getPropertyPhotoPublicUrl = (path) =>
  supabase.storage.from('property-photos').getPublicUrl(path)

export const removePropertyPhotos = (paths) =>
  supabase.storage.from('property-photos').remove(paths)

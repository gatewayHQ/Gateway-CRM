import React, { useState, useRef } from 'react'
import { compressForUpload, IMMUTABLE_CACHE } from '../../lib/imageCompress.js'
import { Icon, pushToast } from '../../components/UI.jsx'
import { uploadPropertyPhoto, getPropertyPhotoPublicUrl, removePropertyPhotos } from '../../lib/services/propertyPhotos.js'

export function PhotoUploader({ photos = [], propertyId, onAdd, onRemove }) {
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver]   = useState(false)
  const inputRef = useRef(null)

  const upload = async (files) => {
    const valid = [...files].filter(f => f.type.startsWith('image/') && f.size <= 10 * 1024 * 1024)
    if (valid.length < files.length) pushToast('Images only, max 10 MB each', 'error')
    if (!valid.length) return
    setUploading(true)
    for (const file of valid) {
      const { blob, ext, type } = await compressForUpload(file, 'property')
      const path = `${propertyId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { data, error } = await uploadPropertyPhoto(path, blob, { contentType: type, upsert: false, cacheControl: IMMUTABLE_CACHE })
      if (error) { pushToast(`Upload failed: ${error.message}`, 'error'); continue }
      const { data: { publicUrl } } = getPropertyPhotoPublicUrl(path)
      onAdd(publicUrl)
    }
    setUploading(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const remove = async (url) => {
    const match = url.match(/property-photos\/(.+?)(\?|$)/)
    if (match) await removePropertyPhotos([decodeURIComponent(match[1])])
    onRemove(url)
  }

  return (
    <div className="photo-uploader">
      <label className="form-label">
        Photos
        <span style={{ fontWeight: 400, color: 'var(--gw-mist)', marginLeft: 6, fontSize: 11 }}>
          shown on public listing page
        </span>
      </label>
      {photos.length > 0 && (
        <div className="photo-uploader__grid">
          {photos.map((url, i) => (
            <div key={url} className="photo-uploader__thumb">
              <img src={url} alt={`Property photo ${i + 1}`} loading="lazy" />
              <button type="button" className="photo-uploader__del" onClick={() => remove(url)} title="Remove">✕</button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`photo-uploader__drop${dragOver ? ' drag-over' : ''}`}
        onClick={() => !uploading && inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files) }}
      >
        <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
          onChange={e => upload(e.target.files)} />
        <Icon name="upload" size={16} style={{ marginBottom: 4 }} />
        <span style={{ fontSize: 12 }}>{uploading ? 'Uploading…' : 'Drop photos or click to browse'}</span>
        {!uploading && <span style={{ fontSize: 11, color: 'var(--gw-mist)' }}>JPEG, PNG, WEBP — up to 10 MB</span>}
      </div>
    </div>
  )
}

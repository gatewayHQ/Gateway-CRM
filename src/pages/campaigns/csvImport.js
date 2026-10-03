// Recipient CSV parsing and best-guess column mapping. Pure.

// ─── CSV parser (handles quoted fields with commas/newlines) ──────────────────

export function parseCSV(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++ }
      else if (c === '"') { inQuotes = false }
      else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && next === '\n') i++
        row.push(field); rows.push(row); row = []; field = ''
      }
      else field += c
    }
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim()))
}

export function autoMapColumns(headers) {
  // Best-guess mapping of CSV column headers → recipient fields
  const map = {}
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i])
    if (map.recipient_name === undefined && /^(name|fullname|recipient|contact)$/.test(h)) map.recipient_name = i
    if (map.first_name === undefined && /^firstname$/.test(h)) map.first_name = i
    if (map.last_name === undefined && /^lastname$/.test(h)) map.last_name = i
    if (map.address_line1 === undefined && /^(address|street|addr|address1|addressline1|streetaddress)$/.test(h)) map.address_line1 = i
    if (map.address_line2 === undefined && /^(address2|addressline2|unit|apt|suite)$/.test(h)) map.address_line2 = i
    if (map.city === undefined && /^city$/.test(h)) map.city = i
    if (map.state === undefined && /^(state|st|province)$/.test(h)) map.state = i
    if (map.zip === undefined && /^(zip|zipcode|postal|postalcode)$/.test(h)) map.zip = i
  }
  return map
}

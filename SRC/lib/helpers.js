export const formatCurrency = (val) => {
  if (!val && val !== 0) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val)
}

export const formatDate = (val) => {
  if (!val) return '—'
  return new Date(val).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export const formatPhone = (val) => {
  if (!val) return '—'
  const d = val.replace(/\D/g, '')
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`
  return val
}

export const getInitials = (firstName, lastName) => {
  return `${(firstName||'')[0]||''}${(lastName||'')[0]||''}`.toUpperCase()
}

export const contactFullName = (c) => c ? `${c.first_name} ${c.last_name}` : '—'

export const STAGE_LABELS = {
  lead: 'Lead', qualified: 'Qualified', showing: 'Showing',
  offer: 'Offer', 'under-contract': 'Under Contract', closed: 'Closed', lost: 'Lost'
}

export const STAGE_ORDER = ['lead','qualified','showing','offer','under-contract','closed','lost']

export const isOverdue = (task) => {
  if (task.completed) return false
  if (!task.due_date) return false
  return new Date(task.due_date) < new Date()
}

export const isToday = (dateStr) => {
  if (!dateStr) return false
  const d = new Date(dateStr)
  const n = new Date()
  return d.toDateString() === n.toDateString()
}

export const isThisWeek = (dateStr) => {
  if (!dateStr) return false
  const d = new Date(dateStr)
  const n = new Date()
  const weekEnd = new Date(n); weekEnd.setDate(n.getDate() + 7)
  return d >= n && d <= weekEnd
}

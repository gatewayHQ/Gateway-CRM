// Follow-up choices offered when an agent logs a call, email or meeting.
// Logging the touch and booking the next one is one step, not two screens.

export const FOLLOW_UP_CHOICES = [
  { id: '',   label: 'No follow-up' },
  { id: '1',  label: 'Tomorrow' },
  { id: '3',  label: 'In 3 days' },
  { id: '7',  label: 'In a week' },
  { id: '14', label: 'In 2 weeks' },
  { id: '30', label: 'In a month' },
]

/** 9am local, `days` from `now`; a weekend lands on the Monday after. */
export function followUpDue(days, now = new Date()) {
  const d = new Date(now)
  d.setDate(d.getDate() + Number(days))
  d.setHours(9, 0, 0, 0)
  const dow = d.getDay()
  if (dow === 6) d.setDate(d.getDate() + 2)
  if (dow === 0) d.setDate(d.getDate() + 1)
  return d
}

// Quick outcomes for a call, so logging one is a tap rather than typing.
export const CALL_OUTCOMES = ['No answer', 'Left voicemail', 'Spoke — interested', 'Spoke — not now']

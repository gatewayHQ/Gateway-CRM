// Key-date reminders already sent for a deal (deadline_reminders), so the Key
// Dates tab can show which thresholds have fired.
import { supabase } from '../supabase.js'

export const fetchDealSentReminders = (dealId) =>
  supabase.from('deadline_reminders').select('date_type, threshold').eq('deal_id', dealId)

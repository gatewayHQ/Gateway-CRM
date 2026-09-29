// ─────────────────────────────────────────────────────────────────────────────
// Mass email bounces — read back from the agent's own inbox.
//
// A blast goes out through the agent's Microsoft 365 mailbox, so "failed" on a
// send only ever meant Microsoft refused the message. The other half of
// failure happens later and somewhere else: the RECEIVING server rejects it
// (the address doesn't exist, the mailbox is full) and a bounce notice —
// "Undeliverable: Just Closed — 1200 Grand Ave" — lands in the agent's inbox.
// Until this module the report went on calling that recipient "sent".
//
// Runs inside the inbox sync (api/_lib/inboxSync.js), on the same delta feed
// that already finds replies, so it costs no extra mailbox pass.
//
// HOW A NOTICE IS RECOGNISED. By its sender (postmaster, mailer-daemon, the
// "Microsoft Outlook" MicrosoftExchange… system address) or its subject
// ("Undeliverable:", "Delivery Status Notification (Failure)", …). Delay
// notices ("still trying") are not bounces and are ignored.
//
// WHO BOUNCED. Every address in the notice is compared against recipients of
// THIS agent's recent sends. Nothing is inferred beyond that: an address the
// agent never mass-mailed is never touched, so a notice about some unrelated
// one-off email, or a stray address quoted in the text, changes nothing.
//
// WHAT HAPPENS. The recipient row is stamped (bounced_at, reason, permanent?),
// the blast's bounced_count is recomputed, a contact gets a timeline note, and
// a PERMANENT bounce adds the address to email_suppressions with reason
// 'bounced' so the next send skips it. A temporary one (mailbox full) does
// not — that address is likely fine next week.
// ─────────────────────────────────────────────────────────────────────────────

// How far back a bounce can still be attributed to a send. Bounces arrive in
// minutes to a couple of days; two weeks is generous and keeps the lookup small.
const BOUNCE_WINDOW_DAYS = 14

// Bodies fetched per sync for notices whose preview names no address. Bounded
// so one agent with a pile of old bounces can't eat the cron's time budget.
const MAX_BODY_FETCHES = 20

const NDR_SENDER  = /(^|[^a-z])(postmaster|mailer-daemon|mail-daemon|maildaemon)@|^microsoftexchange[0-9a-f]{32}@/i
const NDR_SUBJECT = /^\s*(undeliverable|undelivered|non[- ]?delivery|not delivered|delivery status notification \(fail|delivery failure|delivery has failed|delivery notification: delivery has failed|mail delivery failed|mail delivery failure|returned mail|failure notice|message not delivered|could not be delivered|message delivery failure)/i
const DELAY       = /\bdelay(ed)?\b|\(delay\)|still trying|will (keep )?(retry|trying)/i

const EMAIL_IN_TEXT = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi

/** Is this inbox message a bounce notice (and not merely a delay warning)? */
export function isBounceNotice(m) {
  const from    = String(m?.from?.emailAddress?.address || '')
  const subject = String(m?.subject || '')
  if (!NDR_SENDER.test(from) && !NDR_SUBJECT.test(subject)) return false
  if (DELAY.test(subject)) return false
  return true
}

/** Every distinct address in a piece of text, lower-cased. */
export function addressesIn(text) {
  const found = String(text || '').match(EMAIL_IN_TEXT) || []
  return [...new Set(found.map(a => a.toLowerCase().replace(/^['.]+|['.]+$/g, '')))]
    .filter(a => !NDR_SENDER.test(a))
}

// Checked in order; first match wins. `permanent` decides suppression.
const REASONS = [
  { re: /mailbox (is )?full|over (its )?quota|quota exceeded|exceeded (its|the) storage|insufficient (system )?storage|\b5\.2\.2\b|\b4\.2\.2\b/i,
    reason: 'Mailbox full', permanent: false },
  { re: /(domain|host)( name)? (not found|couldn't be found|could not be found|does not exist)|\b5\.1\.2\b|\b5\.4\.(1|4|310)\b|dns (error|failure)/i,
    reason: 'Email domain not found', permanent: true },
  { re: /wasn't found|was not found|not found at|doesn't exist|does not exist|no such (user|mailbox|recipient)|user unknown|unknown (user|recipient)|address couldn't be found|address not found|recipient (address )?rejected|invalid (recipient|mailbox|address)|mailbox unavailable|mailbox not found|account (has been )?(disabled|deactivated)|\b5\.1\.1\b|\b5\.1\.10\b|\b5\.0\.0\b.*(user|recipient)/i,
    reason: 'Address does not exist', permanent: true },
  { re: /blocked|blacklist|spam|policy|rejected|refused|not authori[sz]ed|\b5\.7\.\d+\b/i,
    reason: "Rejected by the recipient's mail server", permanent: false },
]

/** A short human reason for a bounce, and whether it is permanent. */
export function classifyBounce(text) {
  const t = String(text || '')
  for (const r of REASONS) if (r.re.test(t)) return { reason: r.reason, permanent: r.permanent }
  return { reason: 'Could not be delivered', permanent: false }
}

/**
 * Stamp the recipients of this agent's recent sends that bounced.
 *
 * `fetchText(messageId)` returns a notice's full text; it is called only when
 * the subject and preview name no address, and at most MAX_BODY_FETCHES times.
 * Returns the number of recipients newly marked.
 */
export async function markBlastBounces(svc, { agentId, messages = [], fetchText = null }) {
  const notices = messages.filter(isBounceNotice)
  if (!notices.length || !agentId) return 0

  // Resolve each notice to the addresses it mentions, and the text that gives
  // the reason. The preview usually suffices ("Your message to pat@x.com
  // couldn't be delivered…"); the body is fetched only when it doesn't.
  let fetches = 0
  const parsed = []
  for (const m of notices) {
    let text = `${m.subject || ''}\n${m.bodyPreview || ''}`
    let addrs = addressesIn(text)
    if (!addrs.length && fetchText && m.id && fetches < MAX_BODY_FETCHES) {
      fetches++
      try {
        text += `\n${await fetchText(m.id)}`
        addrs = addressesIn(text)
      } catch { /* one unreadable notice must not stop the rest */ }
    }
    if (addrs.length) parsed.push({ m, text, addrs })
  }
  if (!parsed.length) return 0

  const since = new Date(Date.now() - BOUNCE_WINDOW_DAYS * 86_400_000).toISOString()
  const { data: blasts, error: blastErr } = await svc
    .from('email_blasts')
    .select('id')
    .eq('agent_id', agentId)
    .gte('created_at', since)
  if (blastErr || !blasts?.length) return 0

  const wanted = [...new Set(parsed.flatMap(p => p.addrs))]
  const { data: rows, error } = await svc
    .from('email_blast_recipients')
    .select('id, blast_id, email, contact_id, sent_at, bounced_at')
    .in('blast_id', blasts.map(b => b.id))
    .in('email', wanted)
    .eq('status', 'sent')
    .is('bounced_at', null)
    .order('sent_at', { ascending: false })
  // Before migration 0059 the column doesn't exist and this read fails — the
  // reply and contact-mail halves of the sync must carry on regardless.
  if (error || !rows?.length) return 0

  // Newest send per address: a notice is about the message it most recently got.
  const byEmail = new Map()
  for (const r of rows) {
    const key = String(r.email || '').toLowerCase()
    if (!byEmail.has(key)) byEmail.set(key, r)
  }

  const touched = new Set()
  let marked = 0
  for (const { m, text, addrs } of parsed) {
    const when = m.receivedDateTime || new Date().toISOString()
    const { reason, permanent } = classifyBounce(text)
    for (const addr of addrs) {
      const row = byEmail.get(addr)
      if (!row) continue
      // A notice older than the send can't be about it.
      if (row.sent_at && new Date(when) < new Date(row.sent_at)) continue
      byEmail.delete(addr)

      const { error: upErr } = await svc.from('email_blast_recipients').update({
        bounced_at: when, bounce_reason: reason, bounce_permanent: permanent,
      }).eq('id', row.id).is('bounced_at', null)
      if (upErr) continue
      marked++
      touched.add(row.blast_id)

      if (permanent) {
        // ignoreDuplicates: an address that already unsubscribed keeps that
        // reason — "they asked us to stop" outranks "it bounced".
        await svc.from('email_suppressions').upsert([{
          email: addr, reason: 'bounced',
          blast_id: row.blast_id, recipient_id: row.id, contact_id: row.contact_id || null,
          unsubscribed_at: when,
        }], { onConflict: 'email', ignoreDuplicates: true })
      }
      if (row.contact_id) {
        await svc.from('activities').insert([{
          contact_id: row.contact_id,
          agent_id:   agentId,
          type:       'email',
          body:       `Mass email to ${addr} bounced — ${reason.toLowerCase()}.${permanent ? ' This address will be skipped on future sends.' : ''}`,
        }])
      }
    }
  }

  // Recount, never increment — a re-run of the sync must not inflate it.
  for (const blastId of touched) {
    const { count } = await svc
      .from('email_blast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('blast_id', blastId)
      .not('bounced_at', 'is', null)
    await svc.from('email_blasts').update({ bounced_count: count || 0 }).eq('id', blastId)
  }

  return marked
}

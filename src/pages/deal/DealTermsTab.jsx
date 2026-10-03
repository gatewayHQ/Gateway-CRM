// Deal drawer → Terms tab: the contract terms forms are filled from.

import React from 'react'
import { fetchDealCompData, updateDeal } from '../../lib/services/dealRecords.js'
import { readDealTerms, termsForDeal, termsFilled, buildTermsPatch, normalizeTermValue, derivedTermHint } from '../../lib/services/dealTerms.js'
import { pushToast } from '../../components/UI.jsx'

// ── Deal Terms tab — the per-agreement facts with no column of their own ──────
// Twenty tokens in crmTokenValues() read these out of `deals.comp_data`, every
// one of them wired end to end to a template field, and until this tab existed
// nothing in the CRM wrote a single one. So each rendered on the send screen as
// a named, empty box; the agent typed the title company in; the value went onto
// that one draft and died there. Next packet on the same deal, same empty box.
//
// The list is NOT hard-coded here. It comes from DEAL_TERM_GROUPS, the same
// schema whose keys `term()` reads, so a token added there gets an input here
// without anyone remembering to add one — and a test asserts the two agree.
//
// SHORT BY CONSTRUCTION. Only the terms that apply to this deal's side are
// shown: a buyer deal has no listing basis, a seller deal has no
// property-types-sought. A form of twenty boxes that ignores that is a form
// nobody fills in.
export function DealTermsTab({ deal }) {
  const [values, setValues] = React.useState(() => readDealTerms(deal))
  const [saving, setSaving] = React.useState(false)
  const [dirty,  setDirty]  = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)
  // Which groups the agent has opened or closed by hand. Absent = the group
  // decides for itself (open while it still has blanks).
  const [openGroups, setOpenGroups] = React.useState({})

  // Read the deal's own comp_data fresh rather than trusting the row the board
  // handed down — another tab (or another session) may have written since.
  React.useEffect(() => {
    if (!deal?.id) return
    let cancelled = false
    fetchDealCompData(deal.id)
      .then(({ data }) => {
        if (cancelled) return
        setValues(readDealTerms({ comp_data: data?.comp_data || {} }))
        setLoaded(true)
      })
    return () => { cancelled = true }
  }, [deal?.id])

  const groups = termsForDeal(deal, values)
  const { filled, total } = termsFilled(deal, values)

  const set = (key, v) => { setValues(p => ({ ...p, [key]: v })); setDirty(true) }
  // Money and number terms are normalized when the agent leaves the box, not on
  // every keystroke — reformatting under a cursor mid-type is the single most
  // irritating thing a form can do.
  const normalizeOnBlur = (key) => {
    const next = normalizeTermValue(key, values[key])
    if (next !== values[key]) setValues(p => ({ ...p, [key]: next }))
  }

  const save = async () => {
    setSaving(true)
    try {
      // MERGE, never replace. Key dates, portal docs, the state and the
      // transaction type all live in this same jsonb, and a concurrent edit on
      // another tab must survive this write — so comp_data is re-read
      // immediately before merging, the same way KeyDatesTab and PortalTab do.
      const { data, error: readErr } = await fetchDealCompData(deal.id)
      if (readErr) throw readErr
      const comp_data = { ...(data?.comp_data || {}), ...buildTermsPatch(values) }
      const { error } = await updateDeal(deal.id, { comp_data, updated_at: new Date().toISOString() })
      if (error) throw error
      setDirty(false)
      pushToast('Deal terms saved — every agreement for this deal fills these in from now on.', 'success')
    } catch (err) {
      pushToast(`Could not save the deal terms: ${err.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const renderTerm = (t) => {
    const hint = derivedTermHint(t.key, deal)
    return (
      <div key={t.key} className="form-group" style={{ marginBottom:0 }}>
        {/* The explanation moves onto the label rather than sitting under every
            box. Twenty-four fields with two lines of help each is why this tab
            read as a wall; the help is still there for the agent who wants it. */}
        <label className="form-label" style={{ display:'flex', alignItems:'baseline', gap:6 }} title={t.help || undefined}>
          <span>{t.label}</span>
          {t.unit && <span style={{ fontWeight:400, fontSize:11, color:'var(--gw-mist)' }}>({t.unit})</span>}
          {t.help && <span style={{ fontWeight:400, fontSize:10, color:'var(--gw-mist)', cursor:'help' }} aria-hidden="true">ⓘ</span>}
        </label>
        {t.type === 'select'
          ? (
            <select className="form-control" value={values[t.key] || ''} onChange={e => set(t.key, e.target.value)}>
              <option value="">—</option>
              {t.options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )
          : t.type === 'date'
          ? (
            // Stored as ISO because the token runs it through usDate(). A
            // US-formatted string here would reach the agreement half-converted.
            <input
              className="form-control" type="date"
              value={values[t.key] || ''}
              onChange={e => set(t.key, e.target.value)}
            />
          )
          : (
            <input
              className="form-control"
              inputMode={t.type === 'number' ? 'numeric' : undefined}
              placeholder={t.placeholder || (hint ? hint : '')}
              value={values[t.key] || ''}
              onChange={e => set(t.key, e.target.value)}
              onBlur={() => normalizeOnBlur(t.key)}
            />
          )}
      </div>
    )
  }

  return (
    <>
      <div className="drawer__body">
        <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:12, lineHeight:1.6, marginBottom:16 }}>
          <strong>Fill these in once.</strong> Every agreement you send for this deal fills itself in from here — earnest
          money, the title company, the lender, the deadlines. {total > 0 && <><strong>{filled} of {total}</strong> filled.</>}
          {total > 0 && (
            <div style={{ height:4, borderRadius:2, background:'var(--gw-border)', overflow:'hidden', margin:'7px 0 2px' }}
                 role="progressbar" aria-valuenow={filled} aria-valuemin={0} aria-valuemax={total}
                 aria-label={`${filled} of ${total} deal terms filled`}>
              <span style={{ display:'block', height:'100%', width:`${Math.round((filled / total) * 100)}%`, background:'var(--gw-gold)' }} />
            </div>
          )}
          <div style={{ color:'var(--gw-mist)', marginTop:4 }}>
            Only the terms that apply to this deal are shown. Anything left blank simply prints blank on the form,
            where you can still fill it in by hand before sending.
          </div>
        </div>

        {!loaded && <div style={{ fontSize:13, color:'var(--gw-mist)' }}>Loading…</div>}

        {loaded && groups.length === 0 && (
          <div style={{ fontSize:13, color:'var(--gw-mist)', lineHeight:1.6 }}>
            No terms apply to this deal yet. Set whether it is a buyer or seller deal on the{' '}
            <strong>Details</strong> tab and the relevant terms appear here.
          </div>
        )}

        {/* ONE SECTION PER GROUP, AND A FINISHED ONE CLOSES ITSELF.
            The tab used to render every applicable term — up to 24 of them —
            in one column at one volume, so "2 of 15 filled" was true and
            useless: it never said WHICH 13. Each group now carries its own
            count and a dot, and a group with nothing left to fill arrives
            collapsed, so the tab opens on exactly the work that is left. */}
        {loaded && groups.map(g => {
          const done  = g.terms.filter(t => String(values[t.key] ?? '').trim() !== '').length
          const whole = done === g.terms.length
          const open  = openGroups[g.key] ?? !whole
          return (
            <div key={g.key} style={{ marginBottom:14 }}>
              <button
                type="button"
                onClick={() => setOpenGroups(o => ({ ...o, [g.key]: !open }))}
                aria-expanded={open}
                style={{
                  display:'flex', alignItems:'center', gap:8, width:'100%', textAlign:'left',
                  background:'transparent', border:0, borderBottom:'1px solid var(--gw-border)',
                  padding:'4px 2px 6px', marginBottom:8, cursor:'pointer', fontFamily:'var(--font-body)',
                }}
              >
                <span style={{
                  width:7, height:7, borderRadius:'50%', flexShrink:0,
                  background: whole ? 'var(--gw-green)' : done ? 'var(--gw-amber)' : 'var(--gw-border)',
                }} />
                <span style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'var(--gw-ink)' }}>
                  {g.label}
                </span>
                <span style={{ fontSize:11, color:'var(--gw-mist)' }}>{done} of {g.terms.length}</span>
                <span style={{ marginLeft:'auto', fontSize:10, color:'var(--gw-mist)' }}>{open ? '\u25be' : '\u25b8'}</span>
              </button>
              {open && (
                <>
                  {g.help && <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:8, lineHeight:1.5 }}>{g.help}</div>}
                  {/* Two-up wherever the drawer is wide enough for it — the
                      width this tab gained is spent here rather than on longer
                      lines of the same single column. */}
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(210px, 1fr))', gap:12 }}>
                    {g.terms.map(renderTerm)}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
      <div className="drawer__foot">
        <button className="btn btn--primary" onClick={save} disabled={saving || !dirty || !loaded}>
          {saving ? 'Saving…' : dirty ? 'Save Deal Terms' : 'Saved'}
        </button>
      </div>
    </>
  )
}

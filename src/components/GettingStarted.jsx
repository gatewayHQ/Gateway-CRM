import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon } from './UI.jsx'

// ── Getting started ──────────────────────────────────────────────────────────
// The first thing a new agent sees on the dashboard: the five steps from an
// empty CRM to a first signed document, each one a button that opens the right
// screen. Progress is read from data the app already has, never ticked by hand,
// so the card can't claim a step the agent hasn't actually done. It hides itself
// once everything is done, and an agent who doesn't need it can hide it sooner.

const hiddenKey = (agentId) => `gw_getting_started_hidden_${agentId || 'default'}`

const readHidden = (agentId) => {
  try { return localStorage.getItem(hiddenKey(agentId)) === '1' } catch { return false }
}
const writeHidden = (agentId) => {
  try { localStorage.setItem(hiddenKey(agentId), '1') } catch { /* private mode — hides for this visit only */ }
}

/** The agent's own deals: theirs, or one they're a co-agent on. */
export const myDealsFor = (deals, agentId) => (deals || []).filter(d =>
  d.agent_id === agentId || (Array.isArray(d.co_agent_ids) && d.co_agent_ids.includes(agentId)))

/**
 * The steps, in order, each with whether it's done. Pure — the dashboard
 * passes in what it has loaded, and this decides nothing about rendering.
 */
export function gettingStartedSteps({ agentId, contacts = [], properties = [], deals = [], outlookConnected, signatureSent }) {
  const myDeals = myDealsFor(deals, agentId)
  return [
    {
      id: 'outlook',
      title: 'Connect Outlook',
      body: 'Send email from the CRM and put key dates on your calendar.',
      cta: 'Connect',
      done: Boolean(outlookConnected),
    },
    {
      id: 'contact',
      title: 'Add a contact',
      body: 'A client, prospect or owner you’re working with.',
      cta: 'Add contact',
      done: contacts.some(c => c.assigned_agent_id === agentId),
    },
    {
      id: 'property',
      title: 'Add a property',
      body: 'The building or listing your deal is about.',
      cta: 'Add property',
      done: properties.some(p => p.assigned_agent_id === agentId),
    },
    {
      id: 'deal',
      title: 'Start a deal',
      body: 'Link the contact and property. The checklist fills itself in.',
      cta: 'Start deal',
      done: myDeals.length > 0,
    },
    {
      id: 'signature',
      title: 'Send for signature',
      body: 'On the deal: Signatures → Send from Template.',
      cta: 'Open signatures',
      done: Boolean(signatureSent),
    },
  ]
}

// A thin ring that fills as steps are done — reads at a glance, and costs
// nothing on a small screen.
function ProgressRing({ done, total }) {
  const r = 26
  const c = 2 * Math.PI * r
  return (
    <div className="onboard__ring" role="img" aria-label={`${done} of ${total} steps done`}>
      <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="4" />
        <circle
          cx="32" cy="32" r={r} fill="none" stroke="var(--gw-gold)" strokeWidth="4" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - done / total)}
          transform="rotate(-90 32 32)" style={{ transition: 'stroke-dashoffset 600ms ease' }}
        />
      </svg>
      <span className="onboard__ring-count">{done}<small>/{total}</small></span>
    </div>
  )
}


/** The card itself — layout only, so it can be rendered and checked on its own. */
export function GettingStartedCard({ steps, currentId, doneCount, firstName, onRun, onHide }) {
  return (
    <section className="onboard" aria-labelledby="onboard-title">
      <header className="onboard__head">
        <div className="onboard__intro">
          <div className="onboard__eyebrow">Getting started</div>
          <h2 id="onboard-title" className="onboard__title">
            {doneCount === 0 ? `Welcome aboard${firstName ? `, ${firstName}` : ''}` : 'Keep going — you’re on your way'}
          </h2>
          <p className="onboard__sub">
            Five steps from an empty CRM to your first signed document. Each one opens the right screen.
          </p>
        </div>
        <ProgressRing done={doneCount} total={steps.length} />
        <button type="button" className="onboard__hide" onClick={onHide} title="Hide getting started" aria-label="Hide getting started">
          <Icon name="x" size={14} />
        </button>
      </header>

      <ol className="onboard__steps">
        {steps.map((step, i) => {
          const state = step.done ? 'done' : step.id === currentId ? 'current' : 'upcoming'
          return (
            <li key={step.id} className={`onboard-step onboard-step--${state}`}>
              <div className="onboard-step__top">
                <span className="onboard-step__badge" aria-hidden="true">
                  {step.done ? <Icon name="check" size={12} /> : i + 1}
                </span>
                <span className="onboard-step__title">{step.title}</span>
              </div>
              <p className="onboard-step__body">{step.body}</p>
              {step.done ? (
                <span className="onboard-step__done"><Icon name="check" size={12} /> Done</span>
              ) : (
                <button
                  type="button"
                  className={`btn btn--sm ${state === 'current' ? 'btn--primary' : 'btn--secondary'} onboard-step__cta`}
                  onClick={() => onRun(step.id)}
                >
                  {step.cta} <span aria-hidden="true">→</span>
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export default function GettingStarted({ db, activeAgent, go, startNew }) {
  const agentId = activeAgent?.id
  const [hidden, setHidden] = useState(() => readHidden(agentId))
  const [outlookConnected, setOutlookConnected] = useState(null)   // null = still checking
  const [signatureSent, setSignatureSent] = useState(null)

  const myDealIds = myDealsFor(db.deals, agentId).map(d => d.id)
  const dealKey = myDealIds.join(',')

  useEffect(() => { setHidden(readHidden(agentId)) }, [agentId])

  // The two steps the dashboard doesn't already have loaded. Both fail soft:
  // an error reads as "not done yet", which only ever shows a step, never hides
  // one the agent still needs.
  useEffect(() => {
    if (!agentId || hidden) return
    let cancelled = false
    supabase.from('ms_graph_connection_status').select('status').maybeSingle()
      .then(({ data }) => { if (!cancelled) setOutlookConnected(data?.status === 'connected') })
      .catch(() => { if (!cancelled) setOutlookConnected(false) })
    if (!myDealIds.length) { setSignatureSent(false) }
    else {
      supabase.from('boldsign_documents').select('id', { count: 'exact', head: true })
        .in('deal_id', myDealIds).neq('status', 'draft')
        .then(({ count }) => { if (!cancelled) setSignatureSent((count || 0) > 0) })
        .catch(() => { if (!cancelled) setSignatureSent(false) })
    }
    return () => { cancelled = true }
  }, [agentId, hidden, dealKey])

  if (!agentId || hidden || outlookConnected === null || signatureSent === null) return null

  const steps = gettingStartedSteps({
    agentId, contacts: db.contacts, properties: db.properties, deals: db.deals,
    outlookConnected, signatureSent,
  })
  const doneCount = steps.filter(s => s.done).length
  if (doneCount === steps.length) return null
  const currentId = steps.find(s => !s.done)?.id

  const firstDealId = myDealIds[0]
  const run = (id) => ({
    outlook:   () => go('integrations'),
    contact:   () => startNew('contact'),
    property:  () => startNew('property'),
    deal:      () => startNew('deal'),
    signature: () => (firstDealId ? go(`deal/${firstDealId}/signatures`) : startNew('deal')),
  }[id]())

  const hide = () => { writeHidden(agentId); setHidden(true) }

  return (
    <GettingStartedCard
      steps={steps} currentId={currentId} doneCount={doneCount}
      firstName={activeAgent?.name?.split(' ')[0]} onRun={run} onHide={hide}
    />
  )
}

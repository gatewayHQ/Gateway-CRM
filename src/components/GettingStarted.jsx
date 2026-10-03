import React, { useEffect, useState } from 'react'
import { Icon } from './UI.jsx'
import { fetchOutlookConnectionStatus, isOutlookConnected } from '../lib/services/outlook.js'

// ── Getting started ──────────────────────────────────────────────────────────
// The first thing a NEW agent sees on the dashboard: the steps from an empty CRM
// to a first deal, each one a button that opens the right screen. Progress is
// read from data the app already has, never ticked by hand, so the card can't
// claim a step the agent hasn't actually done.
//
// Only new agents see it. An agent with a deal of their own — open, closed or
// lost — has been through this already, so the card never appears for them,
// whatever else they haven't done; office admins never see it either. It also
// leaves the moment a new agent starts their first deal, and can be hidden
// sooner. Sending for signature isn't a step here: the deal's Signatures tab
// walks them through that the first time they open it.

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

/** Whether this agent should see the card at all: new agents only. */
export function isNewAgent({ agentId, isAdmin, deals = [] }) {
  return Boolean(agentId) && !isAdmin && myDealsFor(deals, agentId).length === 0
}

/**
 * The steps, in order, each with whether it's done. Pure — the dashboard
 * passes in what it has loaded, and this decides nothing about rendering.
 */
export function gettingStartedSteps({ agentId, contacts = [], properties = [], deals = [], outlookConnected }) {
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
      body: 'Link the contact and property. Its checklist and signature forms are ready on the deal.',
      cta: 'Start deal',
      done: myDeals.length > 0,
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


const STEP_COUNT_WORDS = { 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six' }

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
            {STEP_COUNT_WORDS[steps.length] || steps.length} steps from an empty CRM to your first deal. Each one opens the right screen.
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

export default function GettingStarted({ db, activeAgent, isAdmin, go, startNew }) {
  const agentId = activeAgent?.id
  const eligible = isNewAgent({ agentId, isAdmin, deals: db.deals })
  const [hidden, setHidden] = useState(() => readHidden(agentId))
  const [outlookConnected, setOutlookConnected] = useState(null)   // null = still checking

  useEffect(() => { setHidden(readHidden(agentId)) }, [agentId])

  // The one step the dashboard doesn't already have loaded. Fails soft: an
  // error reads as "not done yet", which only ever shows a step, never hides one.
  useEffect(() => {
    if (!eligible || hidden) return
    let cancelled = false
    fetchOutlookConnectionStatus()
      .then(({ data }) => { if (!cancelled) setOutlookConnected(isOutlookConnected(data)) })
      .catch(() => { if (!cancelled) setOutlookConnected(false) })
    return () => { cancelled = true }
  }, [agentId, eligible, hidden])

  if (!eligible || hidden || outlookConnected === null) return null

  const steps = gettingStartedSteps({
    agentId, contacts: db.contacts, properties: db.properties, deals: db.deals, outlookConnected,
  })
  const doneCount = steps.filter(s => s.done).length
  if (doneCount === steps.length) return null
  const currentId = steps.find(s => !s.done)?.id

  const run = (id) => ({
    outlook:  () => go('integrations'),
    contact:  () => startNew('contact'),
    property: () => startNew('property'),
    deal:     () => startNew('deal'),
  }[id]())

  const hide = () => { writeHidden(agentId); setHidden(true) }

  return (
    <GettingStartedCard
      steps={steps} currentId={currentId} doneCount={doneCount}
      firstName={activeAgent?.name?.split(' ')[0]} onRun={run} onHide={hide}
    />
  )
}

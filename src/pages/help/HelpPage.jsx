// Help & How-To — step-by-step guides for every task in the CRM, written for
// agents, searchable, and one click from the screen they describe.
//
// Reached from the sidebar ("Help & How-To") or the top bar's "?" button,
// which opens it on the guides for the screen the agent was on.

import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Icon } from '../../components/ui/index.js'
import { pageTitleFor, navRouteFor } from '../../app/navigation.js'
import { CATEGORIES, GUIDES } from './guides/index.js'
import { formatText, groupByCategory, guidesForRoute, searchGuides, visibleGuides } from './guideModel.js'
import './help.css'

/** Text with **label** segments rendered bold — no HTML parsing involved. */
function Rich({ text }) {
  return formatText(text).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <React.Fragment key={i}>{p.text}</React.Fragment>))
}

const categoryOf = (id) => CATEGORIES.find(c => c.id === id)

function GuideLink({ guide, onOpen }) {
  const cat = categoryOf(guide.category)
  return (
    <li>
      <button type="button" className="help-link" onClick={() => onOpen(guide.id)}>
        <span className="help-link__icon" aria-hidden="true"><Icon name={cat?.icon || 'document'} size={16} /></span>
        <span className="help-link__text">
          <span className="help-link__title">{guide.title}</span>
          <span className="help-link__summary">{guide.summary}</span>
        </span>
        {guide.minutes && <span className="help-link__time">{guide.minutes} min</span>}
        <Icon name="chevronRight" size={14} className="help-link__chev" />
      </button>
    </li>
  )
}

function GuideList({ guides, onOpen, label }) {
  return (
    <ul className="help-list" aria-label={label}>
      {guides.map(g => <GuideLink key={g.id} guide={g} onOpen={onOpen} />)}
    </ul>
  )
}

function GuideDetail({ guide, guides, onBack, onOpen, onAction }) {
  const titleRef = useRef(null)
  const cat = categoryOf(guide.category)
  const related = (guide.related || []).map(id => guides.find(g => g.id === id)).filter(Boolean)

  // Move focus to the guide's title so a screen reader starts reading it,
  // and keyboard users aren't left on a button that no longer exists.
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }) }, [guide.id])

  return (
    <article className="help-guide" aria-labelledby="help-guide-title">
      <Button variant="ghost" size="sm" icon="chevronLeft" onClick={onBack} className="help-guide__back">All guides</Button>

      <header className="help-guide__head">
        <div className="eyebrow-label">{cat?.label}</div>
        <h1 id="help-guide-title" ref={titleRef} tabIndex={-1} className="help-guide__title">{guide.title}</h1>
        <p className="help-guide__summary"><Rich text={guide.summary} /></p>
        <div className="help-guide__meta">
          {guide.minutes && <span><Icon name="clock" size={13} /> About {guide.minutes} min</span>}
          <span><Icon name="tasks" size={13} /> {guide.steps.length} steps</span>
          {guide.adminOnly && <span className="help-guide__admin">Office admins only</span>}
        </div>
        {guide.action && (
          <Button variant="primary" icon="send" onClick={() => onAction(guide.action)} className="help-guide__go">
            {guide.action.label}
          </Button>
        )}
      </header>

      {guide.before?.length > 0 && (
        <section className="help-callout" aria-labelledby="help-before">
          <h2 id="help-before" className="help-callout__title"><Icon name="alert" size={14} /> Before you start</h2>
          <ul>{guide.before.map((b, i) => <li key={i}><Rich text={b} /></li>)}</ul>
        </section>
      )}

      <ol className="help-steps">
        {guide.steps.map((s, i) => (
          <li key={i} className="help-step">
            <span className="help-step__num" aria-hidden="true">{i + 1}</span>
            <div className="help-step__body">
              <h2 className="help-step__title"><span className="sr-only">Step {i + 1}: </span>{s.title}</h2>
              <p><Rich text={s.body} /></p>
              {s.tip && <p className="help-step__tip"><strong>Tip:</strong> <Rich text={s.tip} /></p>}
            </div>
          </li>
        ))}
      </ol>

      {guide.troubleshooting?.length > 0 && (
        <section className="help-trouble" aria-labelledby="help-trouble">
          <h2 id="help-trouble" className="help-section-title">If something goes wrong</h2>
          {guide.troubleshooting.map((t, i) => (
            <details key={i} className="help-trouble__item">
              <summary><Rich text={t.problem} /></summary>
              <p><Rich text={t.fix} /></p>
            </details>
          ))}
        </section>
      )}

      {related.length > 0 && (
        <section aria-labelledby="help-related">
          <h2 id="help-related" className="help-section-title">Related guides</h2>
          <GuideList guides={related} onOpen={onOpen} label="Related guides" />
        </section>
      )}
    </article>
  )
}

export default function HelpPage({ isAdmin, go, startNew, focusRecord, onFocusHandled }) {
  const guides = useMemo(() => visibleGuides(GUIDES, { isAdmin }), [isAdmin])
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState(null)
  const [contextRoute, setContextRoute] = useState(null)
  const scrollRef = useRef(null)
  const searchId = useId()

  // The one-shot handoff: "?" in the top bar sends the screen it was pressed
  // on; a deep link sends a guide id.
  useEffect(() => {
    if (!focusRecord) return
    if (focusRecord.type === 'guide') setOpenId(focusRecord.id)
    if (focusRecord.type === 'help-for') { setContextRoute(navRouteFor(focusRecord.route)); setOpenId(null) }
    onFocusHandled?.()
  }, [focusRecord]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = (id) => { setOpenId(id); scrollRef.current?.scrollTo?.({ top: 0 }) }
  const back = () => { setOpenId(null); scrollRef.current?.scrollTo?.({ top: 0 }) }
  const takeMeThere = (action) => (action.startNew && startNew ? startNew(action.startNew) : go?.(action.route))

  const guide = openId && guides.find(g => g.id === openId)
  const results = useMemo(() => searchGuides(guides, query), [guides, query])
  const contextGuides = contextRoute ? guidesForRoute(guides, contextRoute) : []
  const searching = query.trim().length > 0

  return (
    <div className="page-content help" ref={scrollRef}>
      {guide ? (
        <GuideDetail guide={guide} guides={guides} onBack={back} onOpen={open} onAction={takeMeThere} />
      ) : (
        <>
          <div className="page-header">
            <div>
              <h1 className="page-title">Help & How-To</h1>
              <div className="page-sub">Step-by-step guides for everything in the CRM. Pick a task, or search for it.</div>
            </div>
          </div>

          <div className="help-search" role="search">
            <Icon name="search" size={16} />
            <label htmlFor={searchId} className="sr-only">Search the guides</label>
            <input
              id={searchId} type="search" value={query} onChange={e => setQuery(e.target.value)}
              placeholder='Try "import contacts", "split a PDF" or "send for signature"'
              autoComplete="off"
            />
          </div>
          <div role="status" className="sr-only">
            {searching ? `${results.length} guide${results.length === 1 ? '' : 's'} found` : ''}
          </div>

          {searching ? (
            results.length ? (
              <section aria-label="Search results">
                <h2 className="help-section-title">{results.length} guide{results.length === 1 ? '' : 's'} for “{query.trim()}”</h2>
                <GuideList guides={results} onOpen={open} label="Search results" />
              </section>
            ) : (
              <EmptyState
                variant="no-results" title="No guide matches that yet"
                description="Try fewer or different words — or browse the topics below. If you can't find it, ask your office admin and we'll add a guide."
                action={<Button onClick={() => setQuery('')}>Show all guides</Button>}
              />
            )
          ) : (
            <>
              {contextRoute && (
                <section className="help-context" aria-labelledby="help-context-title">
                  <div className="help-context__head">
                    <h2 id="help-context-title" className="help-section-title">
                      Help with {pageTitleFor(contextRoute).title || 'this page'}
                    </h2>
                    <Button size="sm" variant="ghost" onClick={() => setContextRoute(null)}>Show everything</Button>
                  </div>
                  {contextGuides.length
                    ? <GuideList guides={contextGuides} onOpen={open} label={`Guides for ${pageTitleFor(contextRoute).title || 'this page'}`} />
                    : <p className="help-muted">There's no guide for this screen yet — browse the topics below.</p>}
                </section>
              )}

              <div className="help-topics">
                {groupByCategory(guides, CATEGORIES).map(c => (
                  <section key={c.id} className="help-topic" aria-labelledby={`help-cat-${c.id}`}>
                    <h2 id={`help-cat-${c.id}`} className="help-topic__title">
                      <span className="help-topic__icon" aria-hidden="true"><Icon name={c.icon} size={16} /></span>
                      {c.label}
                    </h2>
                    <GuideList guides={c.guides} onOpen={open} label={c.label} />
                  </section>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

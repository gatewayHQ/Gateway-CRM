import React, { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Avatar, EmptyState, pushToast } from '../components/UI.jsx'

function fmtTime(ts) {
  if (!ts) return ''
  const d   = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function initials(name) {
  return (name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

// ── Conversation List ─────────────────────────────────────────────────────────
function ConvList({ convs, activeId, onSelect, agents, filterAgent, setFilterAgent }) {
  const [search, setSearch] = useState('')

  const filtered = convs
    .filter(c => {
      if (filterAgent && c.agent_id !== filterAgent) return false
      const q = search.toLowerCase()
      return (
        (c.contact_name || '').toLowerCase().includes(q) ||
        (c.last_message_body || '').toLowerCase().includes(q) ||
        (c.contact_number || '').includes(q)
      )
    })
    .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at))

  return (
    <div className="msg-list">
      {/* Search + agent filter */}
      <div className="msg-list__head">
        <div className="msg-list__search-wrap">
          <Icon name="search" size={13} style={{ color: 'var(--gw-mist)', flexShrink: 0 }} />
          <input
            className="msg-list__search"
            placeholder="Search conversations…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gw-mist)', padding: 2 }} onClick={() => setSearch('')}>
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
        {agents.length > 1 && (
          <select
            className="filter-select"
            style={{ margin: '0 10px 8px', fontSize: 11 }}
            value={filterAgent}
            onChange={e => setFilterAgent(e.target.value)}
          >
            <option value="">All agents</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>

      {/* List */}
      <div className="msg-list__items">
        {filtered.length === 0 && (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--gw-mist)', fontSize: 13 }}>
            {search ? 'No conversations match.' : 'No conversations yet.\nTexts will appear here automatically.'}
          </div>
        )}
        {filtered.map(c => {
          const isKnown = c.contact_name && c.contact_name !== c.contact_number
          return (
            <div
              key={c.id}
              className={`msg-conv-item${c.id === activeId ? ' active' : ''}`}
              onClick={() => onSelect(c)}
            >
              <div className="msg-conv-item__avatar-wrap">
                <div className="msg-conv-item__avatar" style={{ background: isKnown ? 'var(--gw-azure)' : 'var(--gw-bone)' }}>
                  {isKnown
                    ? <span style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>{initials(c.contact_name)}</span>
                    : <Icon name="phone" size={15} style={{ color: 'var(--gw-mist)' }} />
                  }
                </div>
                {c.unread_count > 0 && (
                  <div className="msg-unread-dot">{c.unread_count > 9 ? '9+' : c.unread_count}</div>
                )}
              </div>
              <div className="msg-conv-item__body">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
                  <span style={{ fontWeight: c.unread_count > 0 ? 700 : 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {c.contact_name || c.contact_number}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--gw-mist)', flexShrink: 0, marginLeft: 6 }}>
                    {fmtTime(c.last_message_at)}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--gw-mist)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.last_message_body || ''}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Message Thread ────────────────────────────────────────────────────────────
function Thread({ conv, msgs, sending, onSend, contacts, onMarkRead }) {
  const [draft, setDraft]   = useState('')
  const bottomRef           = useRef(null)
  const inputRef            = useRef(null)
  const contact             = contacts.find(c => c.id === conv?.contact_id)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs.length])

  useEffect(() => {
    if (!conv) return
    setDraft('')
    inputRef.current?.focus()
    if (conv.unread_count > 0) onMarkRead?.(conv.id)
  }, [conv?.id])

  const handleSend = () => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    onSend(text)
  }

  if (!conv) return (
    <div className="msg-thread msg-thread--empty">
      <EmptyState
        icon="mail"
        title="Select a conversation"
        message="Choose a conversation on the left, or wait for an inbound text to appear."
      />
    </div>
  )

  return (
    <div className="msg-thread">
      {/* Header */}
      <div className="msg-thread__head">
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {conv.contact_name && conv.contact_name !== conv.contact_number
              ? conv.contact_name
              : conv.contact_number}
          </div>
          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2 }}>
            {conv.contact_number}
            {conv.twilio_number && <span> · via {conv.twilio_number}</span>}
          </div>
        </div>
        {contact && (
          <span style={{ fontSize: 11, color: 'var(--gw-azure)', fontWeight: 600, padding: '3px 8px', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Icon name="contacts" size={11} /> Linked contact
          </span>
        )}
      </div>

      {/* Bubbles */}
      <div className="msg-thread__body">
        {msgs.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--gw-mist)', fontSize: 13, padding: '40px 0' }}>
            No messages yet — send the first one.
          </div>
        )}
        {msgs.map((m, i) => {
          const isOut   = m.direction === 'outbound'
          const prevDate = i > 0 ? new Date(msgs[i - 1].created_at).toDateString() : null
          const thisDate = new Date(m.created_at).toDateString()
          return (
            <React.Fragment key={m.id}>
              {prevDate !== thisDate && (
                <div className="msg-date-sep">
                  {new Date(m.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </div>
              )}
              <div className={`msg-row${isOut ? ' out' : ' in'}`}>
                <div className={`msg-bubble${isOut ? ' out' : ' in'}`}>{m.body}</div>
                <div className={`msg-meta${isOut ? ' out' : ' in'}`}>
                  {fmtTime(m.created_at)}
                  {isOut && m.status && m.status !== 'sent' && (
                    <span style={{ marginLeft: 4 }}>· {m.status}</span>
                  )}
                </div>
              </div>
            </React.Fragment>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Compose bar */}
      <div className="msg-compose">
        <textarea
          ref={inputRef}
          className="msg-compose__input"
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          value={draft}
          rows={1}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
        />
        <button
          className="btn btn--primary"
          style={{ flexShrink: 0, padding: '8px 14px' }}
          onClick={handleSend}
          disabled={!draft.trim() || sending}
          aria-label="Send message"
        >
          {sending
            ? <Icon name="refresh" size={14} />
            : <Icon name="send" size={14} />
          }
        </button>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function MessagesPage({ db, activeAgent }) {
  const [convs,       setConvs]       = useState([])
  const [activeConv,  setActiveConv]  = useState(null)
  const [msgs,        setMsgs]        = useState([])
  const [sending,     setSending]     = useState(false)
  const [loading,     setLoading]     = useState(true)
  const [filterAgent, setFilterAgent] = useState(activeAgent?.id || '')
  const [hasTable,    setHasTable]    = useState(true)

  const agents   = db.agents   || []
  const contacts = db.contacts || []

  // ── Load conversations ────────────────────────────────────────────────────
  const loadConvs = useCallback(async () => {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .order('last_message_at', { ascending: false })
    if (error?.code === '42P01') { setHasTable(false); setLoading(false); return }
    setConvs(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { loadConvs() }, [loadConvs])

  // ── Real-time: conversation list ──────────────────────────────────────────
  useEffect(() => {
    const ch = supabase.channel('gw-convs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, loadConvs)
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [loadConvs])

  // ── Real-time: active thread ──────────────────────────────────────────────
  useEffect(() => {
    if (!activeConv?.id) return

    // Load history
    supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', activeConv.id)
      .order('created_at', { ascending: true })
      .then(({ data }) => setMsgs(data || []))

    // Subscribe to new messages
    const ch = supabase.channel(`gw-msgs-${activeConv.id}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: `conversation_id=eq.${activeConv.id}`,
      }, payload => setMsgs(p => [...p, payload.new]))
      .subscribe()

    return () => supabase.removeChannel(ch)
  }, [activeConv?.id])

  // ── Select conversation ───────────────────────────────────────────────────
  const selectConv = (conv) => {
    setActiveConv(conv)
    setMsgs([])
  }

  // ── Mark as read ──────────────────────────────────────────────────────────
  const markRead = async (convId) => {
    setConvs(p => p.map(c => c.id === convId ? { ...c, unread_count: 0 } : c))
    await supabase.from('conversations').update({ unread_count: 0 }).eq('id', convId)
  }

  // ── Send outbound SMS ─────────────────────────────────────────────────────
  const handleSend = async (text) => {
    if (!activeConv) return
    const fromNumber = activeConv.twilio_number || activeAgent?.twilio_number
    if (!fromNumber) {
      pushToast('No Twilio number assigned. Go to Integrations → Twilio to set one up.', 'error')
      return
    }
    setSending(true)

    // Optimistic UI — add message immediately
    const optimistic = {
      id:              `opt-${Date.now()}`,
      conversation_id: activeConv.id,
      direction:       'outbound',
      body:            text,
      status:          'sending',
      agent_id:        activeAgent?.id || null,
      created_at:      new Date().toISOString(),
    }
    setMsgs(p => [...p, optimistic])
    setConvs(p => p.map(c => c.id === activeConv.id
      ? { ...c, last_message_body: text, last_message_at: new Date().toISOString() }
      : c
    ))

    try {
      const res  = await fetch('/api/twilio-send', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:             activeConv.contact_number,
          from:           fromNumber,
          body:           text,
          conversationId: activeConv.id,
          agentId:        activeAgent?.id,
        }),
      })
      const data = await res.json()
      if (data.error) {
        pushToast(data.error, 'error')
        // Remove optimistic message on failure
        setMsgs(p => p.filter(m => m.id !== optimistic.id))
      } else {
        // Replace optimistic with real record
        setMsgs(p => p.map(m => m.id === optimistic.id
          ? { ...m, status: data.status || 'sent', twilio_sid: data.sid }
          : m
        ))
      }
    } catch (err) {
      pushToast(err.message, 'error')
      setMsgs(p => p.filter(m => m.id !== optimistic.id))
    } finally {
      setSending(false)
    }
  }

  // ── Setup required ────────────────────────────────────────────────────────
  if (!hasTable) return (
    <div className="page-content">
      <div className="page-header">
        <div><div className="page-title">Messages</div></div>
      </div>
      <div style={{ background: '#fff8ec', border: '1px solid var(--gw-amber)', borderRadius: 'var(--radius-lg)', padding: 24, maxWidth: 640 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Database setup required</div>
        <div style={{ fontSize: 13, color: 'var(--gw-mist)', marginBottom: 12, lineHeight: 1.6 }}>
          Run the Twilio schema migration in <strong>Supabase → SQL Editor</strong> to enable messaging,
          then add <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3, fontFamily: 'var(--font-mono)' }}>TWILIO_ACCOUNT_SID</code>,{' '}
          <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3, fontFamily: 'var(--font-mono)' }}>TWILIO_AUTH_TOKEN</code>, and{' '}
          <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3, fontFamily: 'var(--font-mono)' }}>SUPABASE_SERVICE_KEY</code> to your Vercel environment variables.
        </div>
        <button className="btn btn--secondary btn--sm" onClick={() => { setHasTable(true); loadConvs() }}>
          <Icon name="refresh" size={12} /> Retry
        </button>
      </div>
    </div>
  )

  const totalUnread = convs.reduce((s, c) => s + (c.unread_count || 0), 0)

  return (
    <div className="page-content" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Page header */}
      <div className="page-header" style={{ padding: '14px 20px', marginBottom: 0, borderBottom: '1px solid var(--gw-border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              Messages
              {totalUnread > 0 && (
                <span style={{ background: 'var(--gw-red)', color: '#fff', borderRadius: 12, fontSize: 11, padding: '1px 8px', fontWeight: 700 }}>
                  {totalUnread}
                </span>
              )}
            </div>
            <div className="page-sub">SMS · powered by Twilio</div>
          </div>
        </div>
        {!activeAgent?.twilio_number && (
          <div style={{ fontSize: 12, color: 'var(--gw-amber)', background: 'var(--gw-amber-light)', padding: '6px 12px', borderRadius: 'var(--radius)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="alert" size={13} />
            No number assigned — go to <strong style={{ marginLeft: 2 }}>Integrations → Twilio</strong>
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gw-mist)', fontSize: 13 }}>
          Loading conversations…
        </div>
      ) : (
        <div className="msg-layout">
          <ConvList
            convs={convs}
            activeId={activeConv?.id}
            onSelect={selectConv}
            agents={agents}
            filterAgent={filterAgent}
            setFilterAgent={setFilterAgent}
          />
          <Thread
            conv={activeConv}
            msgs={msgs}
            sending={sending}
            onSend={handleSend}
            contacts={contacts}
            onMarkRead={markRead}
          />
        </div>
      )}
    </div>
  )
}

import React from 'react'
import { Icon } from '../../components/UI.jsx'

/**
 * The top-bar bell and its dropdown. Open state is owned by the shell, which
 * closes it on any click elsewhere in the app.
 *
 * `onOpenItem(n)` returns the handler for a row that leads somewhere (its
 * contact or deal), or null for one that doesn't.
 */
export default function NotificationBell({ notifications, open, onToggle, onDismiss, onDismissAll, onOpenItem }) {
  return (
    <div style={{ position: 'relative' }}>
      <button
        className="btn btn--ghost btn--icon"
        title="Notifications"
        onClick={onToggle}
        style={{ position: 'relative' }}
      >
        <Icon name="alert" size={16} />
        {notifications.length > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2,
            width: 16, height: 16, borderRadius: '50%',
            background: 'var(--gw-red, #dc2626)', color: '#fff',
            fontSize: 9, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            {notifications.length > 9 ? '9+' : notifications.length}
          </span>
        )}
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 200,
          width: 340, background: '#fff', border: '1px solid var(--gw-border)',
          borderRadius: 'var(--radius)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--gw-border)' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Notifications</span>
            {notifications.length > 0 && (
              <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={onDismissAll}>
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div style={{ padding: '24px 14px', textAlign: 'center', fontSize: 13, color: 'var(--gw-mist)' }}>
              No new notifications
            </div>
          ) : (
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {notifications.map(n => (
                <NotificationRow key={n.id} n={n} open={onOpenItem(n)} onDismiss={() => onDismiss(n.id)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function NotificationRow({ n, open, onDismiss }) {
  return (
    <div style={{
      display: 'flex', gap: 10, padding: '10px 14px',
      borderBottom: '1px solid var(--gw-border)',
      background: '#f0fdf4',
    }}>
      <Icon name={n.type === 'lead' ? 'leads' : 'check'} size={14} style={{ color: 'var(--gw-green)', flexShrink: 0, marginTop: 2 }} />
      <div
        style={{ flex: 1, minWidth: 0, cursor: open ? 'pointer' : 'default' }}
        role={open ? 'button' : undefined} tabIndex={open ? 0 : undefined}
        onClick={open || undefined}
        onKeyDown={open ? (e => { if (e.key === 'Enter') open() }) : undefined}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gw-ink)' }}>{n.title}</div>
        <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2, lineHeight: 1.5 }}>{n.message}</div>
        <div style={{ fontSize: 10, color: 'var(--gw-mist)', marginTop: 4 }}>
          {new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
      <button
        className="btn btn--ghost btn--icon btn--sm"
        title="Dismiss"
        onClick={onDismiss}
        style={{ flexShrink: 0, alignSelf: 'flex-start' }}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  )
}

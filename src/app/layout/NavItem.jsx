import React from 'react'
import { Icon } from '../../components/UI.jsx'

/** One sidebar entry — clickable and keyboard-activatable. */
export default function NavItem({ item, active, collapsed, onSelect, className = '', children }) {
  return (
    <div className={`nav-item${className}${active ? ' active' : ''}`}
      onClick={() => onSelect(item.id)} title={item.label}
      role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onSelect(item.id)}>
      <Icon name={item.icon} size={16} />
      {!collapsed && <span>{item.label}</span>}
      {children}
    </div>
  )
}

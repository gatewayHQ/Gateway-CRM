/** Join class names, skipping falsy ones: cx('btn', busy && 'is-loading'). */
export const cx = (...parts) => parts.filter(Boolean).join(' ')

import { describe, it, expect } from 'vitest'
import { readLaunchIntent } from '../launchIntent.js'

const at = (search, pathname = '/') => readLaunchIntent({ search, pathname })

describe('readLaunchIntent', () => {
  it('is nothing for a plain launch', () => {
    expect(at('')).toBeNull()
  })

  it('lands a successful Outlook connect on Integrations', () => {
    expect(at('?outlook=connected')).toEqual({
      route: 'integrations', toast: { message: 'Outlook connected' }, replaceUrl: '/',
    })
  })

  it('surfaces the Outlook error message', () => {
    expect(at('?outlook=error&message=Denied')).toEqual({
      route: 'integrations', toast: { message: 'Denied', type: 'error' }, replaceUrl: '/',
    })
    expect(at('?outlook=error').toast.message).toBe('Could not connect Outlook')
  })

  it('opens a deal and strips the query', () => {
    expect(at('?deal=d1', '/app')).toEqual({ route: 'deal/d1', replaceUrl: '/app' })
  })

  it('opens a contact and returns to the root', () => {
    expect(at('?contact=c1')).toEqual({
      route: 'contacts', focus: { type: 'contact', id: 'c1' }, replaceUrl: '/',
    })
  })

  it('still honours the pre-Oct-2026 /contacts?id= lead link', () => {
    expect(at('?id=c1', '/contacts/')).toEqual({
      route: 'contacts', focus: { type: 'contact', id: 'c1' }, replaceUrl: '/',
    })
    expect(at('?id=c1', '/elsewhere')).toBeNull()
  })

  it('keeps the query on the markup preview so it survives reloads', () => {
    expect(at('?preview=markup')).toEqual({ route: 'markup-preview' })
  })

  it('lets the Outlook redirect win over anything else in the URL', () => {
    expect(at('?outlook=connected&deal=d1&preview=markup').route).toBe('integrations')
    expect(at('?deal=d1&preview=markup').route).toBe('deal/d1')
  })
})

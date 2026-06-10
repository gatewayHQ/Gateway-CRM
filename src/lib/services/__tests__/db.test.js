import { describe, it, expect } from 'vitest'
import { isTransportError, withRetry, mutationErrorMessage } from '../db.js'

describe('isTransportError', () => {
  it('flags status 0 and fetch failures as transient', () => {
    expect(isTransportError({ message: 'x' }, 0)).toBe(true)
    expect(isTransportError({ message: 'Failed to fetch' }, undefined)).toBe(true)
    expect(isTransportError({ message: 'NetworkError when attempting to fetch' })).toBe(true)
  })

  it('does not flag normal Postgres/validation errors', () => {
    expect(isTransportError({ code: '23514', message: 'violates check constraint' }, 400)).toBe(false)
    expect(isTransportError({ message: 'duplicate key' }, 409)).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns immediately on success without retrying', async () => {
    let calls = 0
    const res = await withRetry(() => { calls++; return Promise.resolve({ data: 1, error: null }) })
    expect(res.data).toBe(1)
    expect(calls).toBe(1)
  })

  it('does NOT retry non-transport errors (e.g. constraint violations)', async () => {
    let calls = 0
    const res = await withRetry(() => {
      calls++
      return Promise.resolve({ error: { code: '23514', message: 'violates check constraint' }, status: 400 })
    })
    expect(calls).toBe(1)
    expect(res.error.code).toBe('23514')
  })

  it('retries transient failures up to the attempt limit', async () => {
    let calls = 0
    const res = await withRetry(() => {
      calls++
      return Promise.resolve({ error: { message: 'Failed to fetch' }, status: 0 })
    }, 3)
    expect(calls).toBe(3)
    expect(res.error).toBeTruthy()
  })

  it('recovers when a later attempt succeeds', async () => {
    let calls = 0
    const res = await withRetry(() => {
      calls++
      return Promise.resolve(calls < 2 ? { error: { message: 'Failed to fetch' }, status: 0 } : { data: 'ok', error: null })
    }, 3)
    expect(res.data).toBe('ok')
    expect(calls).toBe(2)
  })
})

describe('mutationErrorMessage', () => {
  it('gives network guidance for transport errors', () => {
    expect(mutationErrorMessage({ message: 'Failed to fetch' }, 0)).toMatch(/Couldn't reach the server/i)
  })

  it('uses the friendly mapping for known DB errors', () => {
    const msg = mutationErrorMessage({ code: '23514', message: 'violates check constraint "contacts_status_check"' }, 400)
    expect(msg).toMatch(/Status/)
  })

  it('falls back to the raw message, then the generic fallback', () => {
    expect(mutationErrorMessage({ message: 'weird thing' }, 400)).toBe('weird thing')
    expect(mutationErrorMessage({}, 400, 'Could not save.')).toBe('Could not save.')
  })
})

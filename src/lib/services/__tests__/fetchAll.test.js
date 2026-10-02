import { describe, it, expect } from 'vitest'
import { fetchAllRows } from '../fetchAll.js'

// A builder that serves `total` rows in pages, like PostgREST with max-rows.
function table(total, { failOnPage = -1 } = {}) {
  const ranges = []
  const build = () => ({
    order() { return this },
    range(from, to) {
      ranges.push([from, to])
      if (ranges.length - 1 === failOnPage) return Promise.resolve({ data: null, error: { message: 'boom' } })
      const data = []
      for (let i = from; i <= Math.min(to, total - 1); i++) data.push({ id: `r${i}` })
      return Promise.resolve({ data, error: null })
    },
  })
  return { build, ranges }
}

describe('fetchAllRows', () => {
  it('pages past the first thousand', async () => {
    const t = table(2350)
    const { data, error } = await fetchAllRows(t.build)
    expect(error).toBeNull()
    expect(data).toHaveLength(2350)
    expect(t.ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
  it('stops after one request when everything fits', async () => {
    const t = table(12)
    expect((await fetchAllRows(t.build)).data).toHaveLength(12)
    expect(t.ranges).toHaveLength(1)
  })
  it('an error on any page is an error, not a short list', async () => {
    const t = table(2350, { failOnPage: 1 })
    const res = await fetchAllRows(t.build)
    expect(res.data).toBeNull()
    expect(res.error).toBeTruthy()
  })
  it('awaits a non-builder as-is', async () => {
    const res = await fetchAllRows(() => Promise.resolve({ data: [{ id: 1 }], error: null }))
    expect(res.data).toEqual([{ id: 1 }])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Every row, not the first thousand.
//
// PostgREST caps a plain select at the project's max-rows (1,000 by default)
// and says nothing about it: the response is a normal 200 with 1,000 rows. So
// the 1,001st contact, deal or activity simply wasn't in the app — not in the
// list, not in search, not in the dashboard counts — and nothing ever said so.
// This pages through with .range() until a short page says there's no more.
//
// `build` returns a FRESH query each call (Supabase builders are single-use).
// Every page is also ordered by id, after whatever order the caller asked for,
// so rows that tie (two contacts imported in the same second) can't shift
// between pages. Rows are de-duplicated by id as a backstop.
// ─────────────────────────────────────────────────────────────────────────────

export const PAGE_SIZE = 1000
const MAX_PAGES = 100   // 100k rows — a ceiling, not a target

export async function fetchAllRows(build, { pageSize = PAGE_SIZE, orderById = true } = {}) {
  const first = build()
  // Anything that isn't a PostgREST builder (a test double, a plain promise)
  // is awaited as-is.
  if (typeof first?.range !== 'function') return first

  const rows = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * pageSize
    const q = page === 0 ? first : build()
    const { data, error } = await (orderById ? q.order('id') : q).range(from, from + pageSize - 1)
    if (error) return { data: null, error }
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  const seen = new Set()
  return {
    data: rows.filter(r => r?.id == null || (seen.has(r.id) ? false : (seen.add(r.id), true))),
    error: null,
  }
}

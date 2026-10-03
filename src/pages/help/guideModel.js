// Help & How-To — the rules over the guide content. Pure: no React, no DOM.
//
// A guide is plain data (see ./guides/*.js):
//
//   {
//     id, category, title, summary, minutes,
//     keywords: [...],           extra words people search with ("csv", "e-sign")
//     routes:   [...],           the screens it's about — drives the "?" button
//     action:   { label, route, startNew? },   the "Take me there" button
//     adminOnly?: true,          office admins only (hidden from agents)
//     before?:  [...],           what you need first
//     steps:    [{ title, body, tip? }],
//     troubleshooting?: [{ problem, fix }],
//     related?: [guide ids],
//   }
//
// Text uses **double asterisks** around on-screen labels; formatText() turns
// that into bold segments for the page, without any HTML injection.

/** Lower-case, strip accents and punctuation, collapse spaces. */
export const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\*\*/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Guides this person can see — admin-only guides are for office admins. */
export const visibleGuides = (guides, { isAdmin = false } = {}) =>
  guides.filter(g => isAdmin || !g.adminOnly)

// How much a hit in each part of a guide counts. A title match is what someone
// typing "split pdf" almost always wants; a match deep in a troubleshooting
// note is a weak hint.
const WEIGHTS = { title: 10, keywords: 6, summary: 4, steps: 2, troubleshooting: 1 }

function fieldsOf(g) {
  return {
    title: normalize(g.title),
    keywords: normalize((g.keywords || []).join(' ')),
    summary: normalize(g.summary),
    steps: normalize((g.steps || []).map(s => `${s.title} ${s.body} ${s.tip || ''}`).join(' ')),
    troubleshooting: normalize((g.troubleshooting || []).map(t => `${t.problem} ${t.fix}`).join(' ')),
  }
}

// "contacts" should find "contact", "emails" should find "email": compare on a
// crude stem so plurals don't miss.
const stem = (w) => (w.length > 4 && w.endsWith('es') && !w.endsWith('ses') ? w.slice(0, -2)
  : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)

const hasWord = (text, term) =>
  text.split(' ').some(word => word.startsWith(term) || stem(word) === stem(term))

/**
 * Guides matching `query`, best first. Every word of the query must appear
 * somewhere in the guide (so "split pdf" doesn't return every guide that says
 * "pdf"); ranking adds up where each word was found. An empty query returns
 * the guides unchanged.
 */
export function searchGuides(guides, query) {
  const terms = normalize(query).split(' ').filter(Boolean)
  if (!terms.length) return guides
  return guides
    .map((g, i) => {
      const f = fieldsOf(g)
      let score = 0
      for (const term of terms) {
        let best = 0
        for (const [field, weight] of Object.entries(WEIGHTS)) {
          if (hasWord(f[field], term)) best += weight
        }
        if (!best) return null
        score += best
      }
      // A query that is the start of the title outranks everything else.
      if (f.title.startsWith(terms.join(' '))) score += 20
      return { g, i, score }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.g)
}

/** Guides about one screen — what the top bar's "?" opens to. */
export const guidesForRoute = (guides, route) =>
  guides.filter(g => (g.routes || []).includes(route))

/** Guides grouped by category, in category order; empty categories dropped. */
export function groupByCategory(guides, categories) {
  return categories
    .map(c => ({ ...c, guides: guides.filter(g => g.category === c.id) }))
    .filter(c => c.guides.length)
}

/**
 * Split "Click **Save**." into [{ text: 'Click ' }, { text: 'Save', bold: true }, { text: '.' }].
 * An unmatched ** is left as literal text rather than bolding the rest.
 */
export function formatText(text) {
  const parts = String(text ?? '').split('**')
  if (parts.length % 2 === 0) return [{ text: String(text ?? '') }]
  return parts.map((t, i) => ({ text: t, bold: i % 2 === 1 })).filter(p => p.text)
}

/**
 * Problems with the guide content, as human-readable strings — empty when all
 * is well. The test suite runs this so a broken guide (duplicate id, a link to
 * a guide that was renamed, a "Take me there" to a screen that doesn't exist)
 * fails CI instead of failing an agent.
 */
export function validateGuides(guides, { categories, routes }) {
  const problems = []
  const ids = new Set()
  const catIds = new Set(categories.map(c => c.id))
  for (const g of guides) {
    const where = `guide "${g.id}"`
    if (!g.id) problems.push('a guide has no id')
    if (ids.has(g.id)) problems.push(`${where} is defined twice`)
    ids.add(g.id)
    if (!catIds.has(g.category)) problems.push(`${where} has unknown category "${g.category}"`)
    if (!g.title || !g.summary) problems.push(`${where} needs a title and a summary`)
    if (!g.steps?.length) problems.push(`${where} has no steps`)
    for (const [i, s] of (g.steps || []).entries()) {
      if (!s.title || !s.body) problems.push(`${where} step ${i + 1} needs a title and a body`)
    }
    // Every piece of text that gets **bold** formatting must pair its markers.
    const texts = [
      ['summary', g.summary],
      ...(g.before || []).map((t, i) => [`before ${i + 1}`, t]),
      ...(g.steps || []).flatMap((s, i) => [[`step ${i + 1}`, s.body], [`step ${i + 1} tip`, s.tip]]),
      ...(g.troubleshooting || []).flatMap((t, i) => [[`problem ${i + 1}`, t.problem], [`fix ${i + 1}`, t.fix]]),
    ]
    for (const [label, text] of texts) {
      if (text && String(text).split('**').length % 2 === 0) problems.push(`${where} ${label} has an unmatched **`)
    }
    for (const r of g.routes || []) if (!routes.includes(r)) problems.push(`${where} lists unknown screen "${r}"`)
    if (g.action && !routes.includes(g.action.route)) problems.push(`${where} "Take me there" goes to unknown screen "${g.action.route}"`)
    if (g.action?.startNew && !['contact', 'property', 'deal'].includes(g.action.startNew)) {
      problems.push(`${where} can't start a new "${g.action.startNew}"`)
    }
  }
  for (const g of guides) {
    for (const r of g.related || []) if (!ids.has(r)) problems.push(`guide "${g.id}" links to missing guide "${r}"`)
  }
  return problems
}

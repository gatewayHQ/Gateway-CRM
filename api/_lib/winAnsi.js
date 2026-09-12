// ─── Text a standard PDF font can actually draw ───────────────────────────────
// Every PDF this CRM composes with pdf-lib draws its text in a STANDARD font
// (Helvetica and friends). Standard fonts encode with WinAnsi, and WinAnsi has
// no code for most of Unicode — including, fatally, the newline inside a
// multi-line BoldSign textbox. pdf-lib does not skip what it cannot encode, it
// THROWS:
//
//   WinAnsi cannot encode " " (0x000a)
//
// That is thrown from font.widthOfTextAtSize() — the measuring call every
// fit-to-the-box loop makes before drawing — so it surfaces one level under Save
// PDF, Print and Save to Deal alike, killing the whole document. One Iowa
// addendum whose terms box held three lines took out all three buttons with an
// error no agent could act on.
//
// So nothing reaches a standard font unsanitized. Line breaks are meaningful and
// are kept (the caller decides whether to draw a stack of lines or flatten them);
// every other character WinAnsi cannot take is transliterated to its nearest
// drawable equivalent, and only truly unmappable ones become '?' — a single
// wrong glyph in a value beats a printout nobody gets.

// The 0x80–0x9F slots of WinAnsi, which map to these Unicode points rather than
// to control characters. Curly quotes, en/em dashes and '…' live here, so the
// punctuation real documents are full of passes through untouched.
const WINANSI_HIGH = new Set([
  0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178,
])

// Characters that turn up in real field values and read fine as an ASCII stand-in.
const WINANSI_SWAPS = new Map([
  [0x00A0, ' '], [0x2007, ' '], [0x2009, ' '], [0x202F, ' '], [0x200A, ' '],
  [0x200B, ''],  [0x200C, ''],  [0x200D, ''],  [0xFEFF, ''],
  [0x2010, '-'], [0x2011, '-'], [0x2012, '-'], [0x2015, '-'], [0x2212, '-'],
  [0x2032, "'"], [0x2033, '"'],
  [0x2713, 'X'], [0x2714, 'X'], [0x2611, 'X'], [0x2717, 'x'], [0x2718, 'x'],
  [0x2610, '[ ]'], [0x25A0, '#'], [0x25AA, '-'], [0x25CF, '*'], [0x25CB, 'o'],
  [0x2192, '->'], [0x2190, '<-'], [0x21D2, '=>'],
  [0x2044, '/'], [0x2264, '<='], [0x2265, '>='], [0x2260, '!='],
  [0x2028, '\n'], [0x2029, '\n'],
])

// Make `text` safe to hand a standard font. Newlines survive as '\n'; tabs become
// spaces; every other control character is dropped.
export function winAnsiSafe(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').normalize('NFC')
  let out = ''
  for (const ch of src) {
    const cp = ch.codePointAt(0)
    if (cp === 0x0A) { out += '\n'; continue }
    if (cp < 0x20 || cp === 0x7F) continue                       // other control characters
    // Swaps first: a couple of them (the non-breaking space) are perfectly
    // encodable but measure and wrap badly, so they are normalised anyway.
    if (WINANSI_SWAPS.has(cp)) { out += WINANSI_SWAPS.get(cp); continue }
    if (cp <= 0x7E || (cp >= 0xA0 && cp <= 0xFF)) { out += ch; continue }
    if (WINANSI_HIGH.has(cp)) { out += ch; continue }
    // A Latin letter WinAnsi doesn't carry usually survives with its accent
    // stripped — "Ā" prints as "A", which is how a name gets read aloud anyway.
    const folded = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
    out += (folded && folded !== ch) ? winAnsiSafe(folded) : '?'
  }
  return out
}

// One drawable line: a value with its line breaks flattened into spaces. For
// anywhere a value has to fit on a single row — a summary entry, a cover-page
// label — where a stack of lines would collide with whatever sits below it.
export function winAnsiLine(text) {
  return winAnsiSafe(text).replace(/\s+/g, ' ').trim()
}

// The drawable lines of a multi-line value, in order, with the blank lines that
// top and tail it removed. Interior blanks are kept: they are the spacing the
// agent typed between one term and the next.
export function winAnsiLines(text) {
  const lines = winAnsiSafe(text).split('\n').map(l => l.replace(/\s+$/, ''))
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines
}

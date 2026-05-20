import pptxgen from 'pptxgenjs'

// ─── Brand Colors ────────────────────────────────────────────────────────────
const N   = '1E2F39'  // Gateway Navy
const N2  = '243545'  // Mid Navy
const N3  = '0D1820'  // Deep Navy
const G   = 'C8A84B'  // Gold
const W   = 'FFFFFF'  // White
const C   = 'F4F1E8'  // Cream
const C2  = 'E8E4D6'  // Cream Dark
const ST  = 'A2B6C0'  // Steel
const GR  = '8A8A88'  // Gray
const CH  = '3A3A3A'  // Charcoal
const DC  = '162530'  // Dark Card

const WORDMARK_RATIO = 799 / 183  // 4.366

// ─── Helpers ─────────────────────────────────────────────────────────────────
function box(s, x, y, w, h, fill) {
  s.addShape(pptxgen.ShapeType.rect, {
    x, y, w, h,
    fill: { color: fill },
    line: { type: 'none' },
  })
}

function txt(s, text, x, y, w, h, opts = {}) {
  s.addText(text, {
    x, y, w, h,
    fontFace: opts.fontFace || 'Calibri',
    fontSize: opts.fontSize || 10,
    color: opts.color || CH,
    bold: opts.bold || false,
    italic: opts.italic || false,
    align: opts.align || 'left',
    valign: opts.valign || 'middle',
    charSpacing: opts.charSpacing || 0,
    lineSpacingMultiple: opts.lineSpacing || 1,
    wrap: true,
    ...(opts.underline ? { underline: { style: 'sng' } } : {}),
  })
}

function addFooter(s, pg, logoData) {
  box(s, 0, 7.12, 13.3, 0.38, N3)
  txt(s, 'GATEWAY REAL ESTATE ADVISORS', 0.42, 7.23, 5, 0.18, {
    fontSize: 6.5, color: ST, charSpacing: 2.5, fontFace: 'Calibri',
  })
  txt(s, 'CONFIDENTIAL  ·  NOT FOR DISTRIBUTION', 4.5, 7.23, 4.3, 0.18, {
    fontSize: 6.5, color: GR, charSpacing: 1.5, fontFace: 'Calibri', align: 'center',
  })
  if (logoData) {
    const LOGO_H = 0.25
    const LOGO_W = LOGO_H * WORDMARK_RATIO
    s.addImage({ data: logoData, x: 13.3 - LOGO_W - 0.18, y: 7.18, w: LOGO_W, h: LOGO_H })
  }
  txt(s, String(pg), 13.3 - 0.4, 7.23, 0.28, 0.18, {
    fontSize: 7.5, color: G, fontFace: 'Cambria', align: 'right',
  })
}

function sectionHeader(s, num, label) {
  // Left gold bar
  box(s, 0, 0, 0.1, 7.5, G)
  // Top cream band + gold underline
  box(s, 0.1, 0, 13.2, 0.78, C2)
  box(s, 0.1, 0.78, 13.2, 0.022, G)
  // Section badge
  box(s, 0.24, 0.12, 0.52, 0.52, N)
  box(s, 0.24, 0.12, 0.52, 0.052, G)
  txt(s, String(num), 0.24, 0.12, 0.52, 0.52, {
    fontSize: 17, color: W, fontFace: 'Cambria', bold: true, align: 'center', valign: 'middle',
  })
  txt(s, label, 0.9, 0.27, 10, 0.26, {
    fontSize: 8, color: GR, fontFace: 'Calibri', charSpacing: 3,
  })
}

// ─── Slides ──────────────────────────────────────────────────────────────────

function buildSlide1_Cover(prs, property, agents, photos, logoData) {
  const s = prs.addSlide()
  // Full-bleed exterior photo left 55%
  if (photos.exterior) {
    s.addImage({
      data: photos.exterior, x: 0, y: 0, w: 7.32, h: 7.5,
      sizing: { type: 'cover', w: 7.32, h: 7.5 },
    })
  } else {
    box(s, 0, 0, 7.32, 7.5, N2)
    txt(s, 'Exterior Photo', 0, 3, 7.32, 0.5, { color: ST, align: 'center', fontFace: 'Calibri' })
  }
  // Gold vertical bar
  box(s, 7.32, 0, 0.06, 7.5, G)
  // Right navy panel
  const RX = 7.38
  box(s, RX, 0, 5.92, 7.5, N)
  // Wordmark
  if (logoData) {
    const h = 0.34, w = h * WORDMARK_RATIO
    s.addImage({ data: logoData, x: RX + 0.38, y: 0.28, w, h })
  }
  // Labels
  txt(s, 'OFFERING MEMORANDUM', RX + 0.38, 0.82, 5, 0.22, {
    fontSize: 7.5, color: G, charSpacing: 3, fontFace: 'Calibri',
  })
  txt(s, property.name, RX + 0.38, 1.14, 5.3, 1.4, {
    fontSize: 36, color: W, fontFace: 'Cambria', bold: true,
  })
  txt(s, 'APARTMENTS', RX + 0.38, 2.34, 5.3, 0.55, {
    fontSize: 24, color: G, fontFace: 'Cambria',
  })
  txt(s, `${property.address}\n${property.city}`, RX + 0.38, 2.96, 5.3, 0.5, {
    fontSize: 10, color: ST, fontFace: 'Calibri',
  })
  // 2×2 KPI grid
  const kpis = [
    { label: 'ASKING PRICE', value: property.askingPrice },
    { label: 'CAP RATE', value: property.capRate },
    { label: 'TOTAL UNITS', value: property.totalUnits },
    { label: 'PRICE / UNIT', value: property.pricePerUnit },
  ]
  const cardW = (5.3) / 2 - 0.05
  const cardH = 1.22
  const startY = 3.7
  kpis.forEach((k, i) => {
    const col = i % 2, row = Math.floor(i / 2)
    const cx = RX + 0.38 + col * (cardW + 0.1)
    const cy = startY + row * (cardH + 0.1)
    box(s, cx, cy, cardW, cardH, N2)
    box(s, cx, cy, cardW, 0.052, G)
    txt(s, k.label, cx + 0.1, cy + 0.08, cardW - 0.2, 0.2, {
      fontSize: 7, color: ST, fontFace: 'Calibri', charSpacing: 1,
    })
    txt(s, k.value, cx, cy + 0.3, cardW, cardH - 0.4, {
      fontSize: 28, color: W, fontFace: 'Cambria', bold: true, align: 'center', valign: 'middle',
    })
  })
  addFooter(s, '1', logoData)
}

function buildSlide2_TOC(prs, property, logoData) {
  const s = prs.addSlide()
  // Left navy panel
  box(s, 0, 0, 4.2, 7.5, N)
  // Wordmark on left panel
  if (logoData) {
    const h = 0.32, w = h * WORDMARK_RATIO
    s.addImage({ data: logoData, x: 0.38, y: 0.38, w, h })
  }
  txt(s, 'TABLE OF', 0.38, 1.0, 3.4, 0.6, {
    fontSize: 36, color: W, fontFace: 'Cambria', bold: true,
  })
  txt(s, 'CONTENTS', 0.38, 1.56, 3.4, 0.6, {
    fontSize: 36, color: G, fontFace: 'Cambria', bold: true,
  })
  box(s, 0.38, 2.32, 3.2, 0.022, G)
  txt(s, property.name, 0.38, 2.44, 3.4, 0.32, {
    fontSize: 9.5, color: ST, fontFace: 'Calibri',
  })
  txt(s, `${property.address}, ${property.city}`, 0.38, 2.72, 3.4, 0.32, {
    fontSize: 9, color: GR, fontFace: 'Calibri',
  })

  // TOC items
  const items = [
    { num: '01', title: 'Executive Summary', sub: 'Investment Overview & Highlights' },
    { num: '02', title: 'Property Overview', sub: 'Details, Specs & Unit Mix' },
    { num: '03', title: 'Financial Analysis', sub: 'Income, Expenses & NOI' },
    { num: '04', title: 'Market Overview', sub: 'Local Market & Demographics' },
    { num: '05', title: 'Photo Gallery', sub: 'Property Photography' },
    { num: '06', title: 'Listing Agents', sub: 'Meet the Team' },
    { num: '07', title: 'About Gateway', sub: 'Firm Overview & Track Record' },
    { num: '08', title: 'Offering Terms', sub: 'Pricing & Contact Information' },
  ]
  const rowH = (7.5 - 0.36) / items.length
  items.forEach((item, i) => {
    const ry = i * rowH
    box(s, 4.2, ry, 9.1, rowH, i % 2 === 0 ? C : C2)
    box(s, 4.2, ry, 0.052, rowH, G)
    txt(s, item.num, 4.36, ry + (rowH - 0.38) / 2, 0.7, 0.38, {
      fontSize: 18, color: G, fontFace: 'Cambria', bold: true,
    })
    txt(s, item.title, 5.16, ry + (rowH - 0.36) / 2, 7.8, 0.26, {
      fontSize: 10.5, color: N, fontFace: 'Calibri', bold: true,
    })
    txt(s, item.sub, 5.16, ry + (rowH - 0.36) / 2 + 0.26, 7.8, 0.22, {
      fontSize: 9, color: GR, fontFace: 'Calibri',
    })
  })
}

function buildSlide3_ExecutiveSummary(prs, property, financials, logoData) {
  const s = prs.addSlide()
  box(s, 0, 0, 13.3, 7.5, C)
  sectionHeader(s, '01', 'EXECUTIVE SUMMARY')

  // Left content
  txt(s, property.name, 0.38, 1.0, 7.8, 0.7, {
    fontSize: 28, color: N, fontFace: 'Cambria', bold: true,
  })
  box(s, 0.38, 1.78, 7.6, 0.022, G)
  txt(s, `${property.name} is a ${property.totalUnits}-unit multifamily property located in ${property.city}. Built in ${property.yearBuilt}, this ${property.assetClass.toLowerCase()} asset offers investors a stable, income-producing opportunity in a growing market with strong occupancy and reliable cash flow.`,
    0.38, 1.9, 7.8, 1.1, {
      fontSize: 10.5, color: CH, fontFace: 'Calibri', lineSpacing: 1.42,
    })

  txt(s, 'INVESTMENT HIGHLIGHTS', 0.38, 3.1, 7.8, 0.26, {
    fontSize: 7.5, color: GR, fontFace: 'Calibri', charSpacing: 2,
  })
  box(s, 0.38, 3.38, 7.6, 0.022, G)

  const bullets = [
    { lead: `${property.occupancy} Occupied`, body: `All ${property.totalUnits} units currently leased — immediate cash flow from day one` },
    { lead: `${property.capRate} Cap Rate`, body: `Strong current yield with pro forma upside as rents are marked to market` },
    { lead: `${property.pricePerUnit} Per Unit`, body: `Well below replacement cost with value-add potential through unit upgrades` },
    { lead: `Established Market`, body: `${property.city} benefits from stable demand drivers and limited new supply` },
  ]
  bullets.forEach((b, i) => {
    const by = 3.5 + i * 0.68
    box(s, 0.38, by + 0.08, 0.12, 0.12, G)
    txt(s, `${b.lead} — `, 0.62, by, 1.8, 0.3, {
      fontSize: 10.5, color: CH, fontFace: 'Calibri', bold: true,
    })
    txt(s, `${b.lead} — ${b.body}`, 0.62, by, 7.4, 0.56, {
      fontSize: 10.5, color: CH, fontFace: 'Calibri',
    })
  })

  // Right KPI column
  const gold_bar_x = 8.465
  box(s, gold_bar_x, 0.36, 0.022, 7.5 - 0.36, G)
  const cardTotalH = 7.5 - 0.36
  const cardH = cardTotalH / 3
  const kpis = [
    { label: 'NET OPERATING INCOME', value: property.noi, desc: 'Current Annual NOI' },
    { label: 'GROSS RENT MULTIPLIER', value: property.grm, desc: 'Purchase Price / Gross Rent' },
    { label: 'OCCUPANCY RATE', value: property.occupancy, desc: `${property.totalUnits} of ${property.totalUnits} Units Occupied` },
  ]
  kpis.forEach((k, i) => {
    const cy = 0.36 + i * cardH
    const cx = 8.52
    const cw = 13.3 - cx - 0.1
    box(s, cx, cy, cw, cardH, N)
    box(s, cx, cy, cw, 0.06, G)
    txt(s, k.label, cx + 0.14, cy + 0.1, cw - 0.28, 0.22, {
      fontSize: 7.5, color: ST, fontFace: 'Calibri', charSpacing: 2,
    })
    box(s, cx, cy + 0.38, cw, 0.022, G)
    const innerY = cy + 0.52
    const innerH = cardH - 0.58
    box(s, cx, innerY, cw, innerH, N2)
    box(s, cx, innerY, cw, 0.03, G)
    txt(s, k.value, cx, innerY + 0.04, cw, innerH - 0.28, {
      fontSize: 44, color: W, fontFace: 'Cambria', align: 'center', valign: 'middle',
    })
    txt(s, k.desc, cx + 0.1, innerY + innerH - 0.28, cw - 0.2, 0.22, {
      fontSize: 7.5, color: GR, fontFace: 'Calibri', italic: true,
    })
    if (i < 2) box(s, cx, cy + cardH - 0.022, cw, 0.022, G)
  })

  addFooter(s, '2', logoData)
}

function buildSlide4_PropertyOverview(prs, property, logoData) {
  const s = prs.addSlide()
  box(s, 0, 0, 13.3, 7.5, C)
  sectionHeader(s, '02', 'PROPERTY OVERVIEW')

  // Left content
  txt(s, property.address, 0.38, 1.0, 7.7, 0.58, {
    fontSize: 22, color: N, fontFace: 'Cambria', bold: true,
  })
  txt(s, property.city, 0.38, 1.6, 7.7, 0.32, {
    fontSize: 16, color: N, fontFace: 'Cambria',
  })
  txt(s, `${property.name} is a ${property.totalUnits}-unit ${property.propertyType.toLowerCase()} community located in ${property.city}. The property offers a stable tenant base and strong occupancy, making it an ideal investment for cash-flow-focused buyers.`,
    0.38, 2.06, 7.6, 0.88, {
      fontSize: 10.5, color: CH, fontFace: 'Calibri', lineSpacing: 1.42,
    })
  txt(s, `${property.totalUnits} Units  ·  Built ${property.yearBuilt}  ·  ${property.lotSize}  ·  ${property.parking}`,
    0.38, 3.0, 7.6, 0.3, {
      fontSize: 9.5, color: CH, fontFace: 'Calibri',
    })

  // Unit mix table
  const tableY = 3.42
  const tableW = 7.8
  const colW = [tableW * 0.25, tableW * 0.25, tableW * 0.25, tableW * 0.25]
  const headers = ['Unit Type', 'Units', 'Avg SF', 'Avg Rent']
  box(s, 0.38, tableY, tableW, 0.38, N)
  headers.forEach((h, i) => {
    txt(s, h, 0.38 + colW.slice(0, i).reduce((a, b) => a + b, 0), tableY + 0.04, colW[i], 0.3, {
      fontSize: 8.5, color: W, fontFace: 'Calibri', bold: true, align: 'center',
    })
  })
  const rows = [
    ['Studio', '4', '420', '$595'],
    ['1 Bedroom', '12', '575', '$695'],
    ['2 Bedroom', '8', '780', '$850'],
    ['TOTAL', '24', '–', '–'],
  ]
  rows.forEach((row, ri) => {
    const ry = tableY + 0.38 + ri * 0.34
    const isTotal = ri === rows.length - 1
    box(s, 0.38, ry, tableW, 0.34, isTotal ? G : ri % 2 === 0 ? C : C2)
    row.forEach((cell, ci) => {
      txt(s, cell, 0.38 + colW.slice(0, ci).reduce((a, b) => a + b, 0), ry + 0.04, colW[ci], 0.26, {
        fontSize: 9, color: isTotal ? N : CH, fontFace: 'Calibri',
        bold: isTotal, align: 'center',
      })
    })
  })

  // Right specs panel — full navy
  const RX = 8.42
  box(s, RX, 0, 13.3 - RX, 7.5, N)
  txt(s, 'PROPERTY SPECIFICATIONS', RX + 0.18, 0.14, 4.7, 0.24, {
    fontSize: 7.5, color: ST, fontFace: 'Calibri', charSpacing: 1.5,
  })
  const specs = [
    { label: 'YEAR BUILT', value: property.yearBuilt },
    { label: 'TOTAL UNITS', value: property.totalUnits },
    { label: 'BUILDINGS', value: property.buildings },
    { label: 'PROPERTY TYPE', value: property.propertyType },
    { label: 'LOT SIZE', value: property.lotSize },
    { label: 'PARKING', value: property.parking },
    { label: 'OCCUPANCY', value: property.occupancy },
    { label: 'ASSET CLASS', value: property.assetClass },
  ]
  const cellH = (7.5 - 0.36 - 0.48) / 4
  const cellW = (13.3 - RX) / 2
  specs.forEach((sp, i) => {
    const col = i % 2, row = Math.floor(i / 2)
    const cx = RX + col * cellW
    const cy = 0.48 + row * cellH
    box(s, cx, cy, cellW, cellH, N2)
    box(s, cx, cy, cellW, 0.042, G)
    txt(s, sp.label, cx + 0.14, cy + 0.1, cellW - 0.28, 0.2, {
      fontSize: 6.5, color: ST, fontFace: 'Calibri', charSpacing: 1,
    })
    txt(s, sp.value, cx + 0.14, cy + 0.34, cellW - 0.28, 0.5, {
      fontSize: 18, color: W, fontFace: 'Cambria', bold: false,
    })
  })

  addFooter(s, '3', logoData)
}

function buildSlide5_Financial(prs, financials, logoData) {
  const s = prs.addSlide()
  const sx = 13.3 / 10, sy = 7.5 / 5.625

  box(s, 0, 0, 13.3, 7.5, C)
  // Header bar
  box(s, 0, 0, 10 * sx, 0.7 * sy, N)
  box(s, 0, 0, 0.06 * sx, 0.7 * sy, G)
  box(s, 0, 0.7 * sy, 10 * sx, 0.018 * sy, G)
  txt(s, '03  FINANCIAL ANALYSIS', 0.24, 0.08, 9, 0.7 * sy - 0.16, {
    fontSize: 20, color: W, fontFace: 'Cambria', bold: true, valign: 'middle',
  })

  // 4 KPI cards
  const kpiCards = [
    { label: financials.current.kpiLabel, value: financials.current.kpiValue, sub: financials.current.kpiSub, accent: ST },
    { label: financials.current.kpiNOILabel, value: financials.current.kpiNOIValue, sub: financials.current.kpiNOISub, accent: ST },
    { label: financials.proForma.kpiLabel, value: financials.proForma.kpiValue, sub: financials.proForma.kpiSub, accent: G },
    { label: financials.proForma.kpiNOILabel, value: financials.proForma.kpiNOIValue, sub: financials.proForma.kpiNOISub, accent: G },
  ]
  const kpiXs = [0.35, 2.70, 5.05, 7.40].map(x => x * sx)
  const kpiY = 0.82 * sy
  const kpiW = 2.2 * sx, kpiH = 0.72 * sy
  kpiCards.forEach((k, i) => {
    box(s, kpiXs[i], kpiY, kpiW, kpiH, DC)
    box(s, kpiXs[i], kpiY, kpiW, 0.052, k.accent)
    txt(s, k.label, kpiXs[i] + 0.08, kpiY + 0.06, kpiW - 0.16, 0.2, {
      fontSize: 7, color: ST, fontFace: 'Calibri', charSpacing: 1,
    })
    txt(s, k.value, kpiXs[i], kpiY + 0.26, kpiW, kpiH - 0.34, {
      fontSize: 26, color: W, fontFace: 'Cambria', bold: true, align: 'center', valign: 'middle',
    })
    txt(s, k.sub, kpiXs[i] + 0.08, kpiY + kpiH - 0.2, kpiW - 0.16, 0.18, {
      fontSize: 6.5, color: GR, fontFace: 'Calibri', italic: true,
    })
  })

  // Two I&E tables
  const tableY = (0.82 + 0.72 + 0.15) * sy
  const tableH = 7.12 - tableY
  const tW = 4.35 * sx
  const leftX = 0.35 * sx
  const rightX = 5.30 * sx
  const divX = 4.88 * sx, divW = 0.24 * sx

  // Center divider
  box(s, divX, tableY, divW, tableH, C2)

  function drawTable(startX, data, label) {
    let ry = tableY
    const rowH = tableH / (data.length + 1)

    // INCOME header
    const incomeRows = data.income
    const expenseRows = data.expenses
    const allRows = [
      { type: 'incomeHeader', label: 'INCOME', value: '' },
      ...incomeRows,
      { type: 'egi', label: 'EGI', value: data.egi },
      { type: 'expenseHeader', label: 'EXPENSES', value: '' },
      ...expenseRows,
      { type: 'total', label: 'TOTAL EXPENSES', value: data.te },
      { type: 'noi', label: 'NET OPERATING INCOME', value: data.noi },
    ]
    const rH = tableH / allRows.length
    allRows.forEach((row, ri) => {
      const cy = tableY + ri * rH
      let bg = ri % 2 === 0 ? C : C2
      let labelColor = CH, valueColor = CH, bold = false
      if (row.type === 'incomeHeader' || row.type === 'expenseHeader') {
        bg = G; labelColor = N; bold = true
      } else if (row.type === 'egi' || row.type === 'total') {
        bg = N; labelColor = W; valueColor = G; bold = true
      } else if (row.type === 'noi') {
        bg = G; labelColor = N; valueColor = N; bold = true
      }
      box(s, startX, cy, tW, rH, bg)
      txt(s, row.label, startX + 0.1, cy, tW * 0.65, rH, {
        fontSize: 8.5, color: labelColor, fontFace: 'Calibri', bold, valign: 'middle',
      })
      if (row.value) {
        txt(s, row.value, startX + tW * 0.62, cy, tW * 0.36, rH, {
          fontSize: 8.5, color: valueColor, fontFace: 'Calibri', bold, align: 'right', valign: 'middle',
        })
      }
      if (row.type === 'incomeHeader') {
        txt(s, label, startX + tW / 2, cy, tW / 2, rH, {
          fontSize: 8, color: N, fontFace: 'Calibri', bold: true, align: 'right', valign: 'middle',
        })
      }
    })
  }

  drawTable(leftX, {
    income: [
      { label: 'Gross Rental Income', value: financials.current.gri },
      { label: 'Vacancy & Credit Loss', value: financials.current.vcl },
    ],
    egi: financials.current.egi,
    expenses: [
      { label: 'Property Taxes', value: financials.current.pt },
      { label: 'Insurance', value: financials.current.ins },
      { label: 'Management', value: financials.current.mgmt },
      { label: 'Maintenance', value: financials.current.maint },
      { label: 'Utilities', value: financials.current.util },
      { label: 'Legal/Admin', value: financials.current.ls },
    ],
    te: financials.current.te,
    noi: financials.current.noi,
  }, 'CURRENT')

  drawTable(rightX, {
    income: [
      { label: 'Gross Rental Income', value: financials.proForma.gri },
      { label: 'Vacancy & Credit Loss', value: financials.proForma.vcl },
    ],
    egi: financials.proForma.egi,
    expenses: [
      { label: 'Property Taxes', value: financials.proForma.pt },
      { label: 'Insurance', value: financials.proForma.ins },
      { label: 'Management', value: financials.proForma.mgmt },
      { label: 'Maintenance', value: financials.proForma.maint },
      { label: 'Utilities', value: financials.proForma.util },
      { label: 'Legal/Admin', value: financials.proForma.ls },
    ],
    te: financials.proForma.te,
    noi: financials.proForma.noi,
  }, 'PRO FORMA')

  // Footer (cream style per spec)
  const footerY = 5.35 * sy
  box(s, 0, footerY, 13.3, 7.5 - footerY, C2)
  box(s, 0, footerY, 13.3, 0.022, G)
  if (logoData) {
    const h = 0.22, w = h * WORDMARK_RATIO
    s.addImage({ data: logoData, x: 13.3 - w - 0.2, y: footerY + (7.5 - footerY - h) / 2, w, h })
  }
  txt(s, 'CONFIDENTIAL  ·  NOT FOR DISTRIBUTION', 0.38, footerY, 8, 7.5 - footerY, {
    fontSize: 6.5, color: GR, fontFace: 'Calibri', charSpacing: 1.5, valign: 'middle',
  })
}

function buildSlide6_Market(prs, property, market, logoData) {
  const s = prs.addSlide()
  box(s, 0, 0, 13.3, 7.5, C)
  sectionHeader(s, '04', 'MARKET OVERVIEW')

  txt(s, market.city, 0.38, 1.0, 12, 0.6, {
    fontSize: 28, color: N, fontFace: 'Cambria', bold: true,
  })
  txt(s, `${market.city} is a growing community offering stable economic fundamentals and consistent demand for multifamily housing. The University of South Dakota anchors the local economy, providing a reliable base of students, faculty, and staff seeking quality rental housing year-round.`,
    0.38, 1.7, 12.5, 0.88, {
      fontSize: 10.5, color: CH, fontFace: 'Calibri', lineSpacing: 1.42,
    })

  // 4 market stat cards
  const stats = [
    { label: 'POPULATION', value: market.population },
    { label: 'MEDIAN INCOME', value: market.medianIncome },
    { label: 'UNEMPLOYMENT', value: market.unemployment },
    { label: 'AVG MONTHLY RENT', value: market.avgRent },
  ]
  const statW = (13.3 - 0.76 - 0.18 * 3) / 4
  stats.forEach((st, i) => {
    const cx = 0.38 + i * (statW + 0.18)
    const cy = 2.72
    box(s, cx, cy, statW, 1.28, N)
    box(s, cx, cy, statW, 0.052, G)
    txt(s, st.label, cx + 0.12, cy + 0.1, statW - 0.24, 0.22, {
      fontSize: 7.5, color: ST, fontFace: 'Calibri', charSpacing: 1,
    })
    txt(s, st.value, cx, cy + 0.32, statW, 0.8, {
      fontSize: 30, color: W, fontFace: 'Cambria', bold: true, align: 'center', valign: 'middle',
    })
  })

  // 3 driver cards
  const drivers = [
    { title: 'University Anchor', body: 'University of South Dakota enrollment drives consistent demand for housing, supporting year-round occupancy.' },
    { title: 'Limited New Supply', body: 'Minimal new multifamily construction keeps vacancy rates low and supports rent growth in the market.' },
    { title: 'Affordable Market', body: 'Below-average home prices and rents attract a diverse renter base seeking quality housing at accessible price points.' },
  ]
  const dW = (13.3 - 0.76 - 0.18 * 2) / 3
  drivers.forEach((d, i) => {
    const cx = 0.38 + i * (dW + 0.18)
    const cy = 4.22
    box(s, cx, cy, dW, 2.66, W)
    box(s, cx, cy, dW, 0.048, G)
    txt(s, d.title, cx + 0.18, cy + 0.14, dW - 0.36, 0.32, {
      fontSize: 8.5, color: N, fontFace: 'Calibri', bold: true,
    })
    txt(s, d.body, cx + 0.18, cy + 0.52, dW - 0.36, 2.0, {
      fontSize: 9.5, color: CH, fontFace: 'Calibri', lineSpacing: 1.4,
    })
  })

  addFooter(s, '4', logoData)
}

function buildSlide7_PhotoGallery(prs, photos, logoData) {
  const s = prs.addSlide()
  box(s, 0, 0, 13.3, 7.5, N3)
  // Header
  const headerH = 0.86
  box(s, 0, 0, 13.3, headerH, N)
  box(s, 0, 0, 0.1, headerH, G)
  box(s, 0.1, headerH - 0.022, 13.2, 0.022, G)
  txt(s, '05  PHOTO GALLERY', 0.38, 0.18, 12, headerH - 0.36, {
    fontSize: 18, color: W, fontFace: 'Cambria', bold: true, valign: 'middle',
  })

  const GAP = 0.06
  const slotW = (13.3 - GAP * 2) / 3
  const slotH = (7.5 - headerH - GAP) / 2

  const positions = [
    { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 },
    { r: 1, c: 0 }, { r: 1, c: 1 }, { r: 1, c: 2 },
  ]
  const photoKeys = ['exterior', 'kitchen', 'living', 'bathroom', 'kitchen2', 'exterior']

  positions.forEach(({ r, c }, i) => {
    const px = c * (slotW + GAP)
    const py = headerH + r * (slotH + GAP)
    const photoData = photos[photoKeys[i]]
    if (photoData) {
      s.addImage({
        data: photoData, x: px, y: py, w: slotW, h: slotH,
        sizing: { type: 'cover', w: slotW, h: slotH },
      })
    } else {
      box(s, px, py, slotW, slotH, N2)
      txt(s, photoKeys[i].charAt(0).toUpperCase() + photoKeys[i].slice(1), px, py + slotH / 2 - 0.15, slotW, 0.3, {
        fontSize: 10, color: ST, fontFace: 'Calibri', align: 'center',
      })
    }
    box(s, px, py, slotW, 0.042, G)
  })
}

function buildSlide8_Agents(prs, agents, property, logoData) {
  const s = prs.addSlide()
  box(s, 0, 0, 13.3, 7.5, C)
  sectionHeader(s, '06', 'LISTING AGENTS')

  txt(s, 'Meet the Team', 0.38, 1.0, 12.5, 0.6, {
    fontSize: 32, color: N, fontFace: 'Cambria', bold: true,
  })

  const cardW = 6.18
  agents.slice(0, 2).forEach((agent, i) => {
    const cx = i === 0 ? 0.38 : 6.74
    const cy = 1.76

    // Card
    box(s, cx, cy, cardW, 5.1, C2)
    box(s, cx, cy, cardW, 0.06, G)

    // Navy header band
    box(s, cx, cy, cardW, 1.78, N)

    // Initials circle (simulated with shape)
    const circleX = cx + cardW / 2 - 0.52
    const circleY = cy + 0.38
    box(s, circleX, circleY, 1.04, 1.04, N2)
    txt(s, agent.init, circleX, circleY, 1.04, 1.04, {
      fontSize: 30, color: W, fontFace: 'Cambria', bold: true, align: 'center', valign: 'middle',
    })

    txt(s, agent.name, cx + 0.2, cy + 1.66, cardW - 0.4, 0.4, {
      fontSize: 19, color: W, fontFace: 'Cambria', align: 'center',
    })

    txt(s, agent.title, cx + 0.2, cy + 2.1, cardW - 0.4, 0.28, {
      fontSize: 8, color: ST, fontFace: 'Calibri', charSpacing: 1.5, align: 'center',
    })

    box(s, cx + 0.4, cy + 2.46, cardW - 0.8, 0.022, G)

    txt(s, agent.phone, cx + 0.2, cy + 2.56, cardW - 0.4, 0.42, {
      fontSize: 17, color: N, fontFace: 'Calibri', bold: true, align: 'center',
    })
    txt(s, agent.email, cx + 0.2, cy + 3.0, cardW - 0.4, 0.3, {
      fontSize: 10.5, color: GR, fontFace: 'Calibri', align: 'center',
    })
    txt(s, agent.lic, cx + 0.2, cy + 3.38, cardW - 0.4, 0.28, {
      fontSize: 8.5, color: ST, fontFace: 'Calibri', italic: true, align: 'center',
    })
  })

  txt(s, 'Gateway Real Estate Advisors  ·  Commercial Division', 0.38, 7.0, 12.5, 0.22, {
    fontSize: 8.5, color: GR, fontFace: 'Calibri', align: 'center',
  })

  addFooter(s, '6', logoData)
}

function buildSlide9_AboutGateway(prs, logoData) {
  const s = prs.addSlide()
  box(s, 0, 0, 13.3, 7.5, C)
  sectionHeader(s, '07', 'ABOUT GATEWAY')

  txt(s, 'Gateway Real Estate Advisors', 0.38, 1.0, 12.5, 0.6, {
    fontSize: 28, color: N, fontFace: 'Cambria', bold: true,
  })
  txt(s, 'Gateway Real Estate Advisors is a full-service commercial real estate firm specializing in multifamily investment sales across Iowa, South Dakota, and Nebraska. Our team combines local market expertise with institutional-grade underwriting to deliver superior results for buyers and sellers alike.',
    0.38, 1.7, 12.5, 0.88, {
      fontSize: 10.5, color: CH, fontFace: 'Calibri', lineSpacing: 1.42,
    })
  txt(s, 'We represent both private investors and institutional clients, providing comprehensive transaction management from initial listing to close. Our deep market relationships and proprietary buyer network ensure maximum exposure and competitive pricing for every asset we represent.',
    0.38, 2.66, 12.5, 0.88, {
      fontSize: 10.5, color: CH, fontFace: 'Calibri', lineSpacing: 1.42,
    })

  // 3 stat cards
  const stats = [
    { label: 'TRANSACTIONS CLOSED', value: '200+' },
    { label: 'ASSETS SOLD', value: '$250M+' },
    { label: 'YEARS EXPERIENCE', value: '15+' },
  ]
  const statW = (13.3 - 0.76 - 0.18 * 2) / 3
  stats.forEach((st, i) => {
    const cx = 0.38 + i * (statW + 0.18)
    const cy = 3.7
    box(s, cx, cy, statW, 1.26, N)
    box(s, cx, cy, statW, 0.052, G)
    txt(s, st.value, cx, cy + 0.12, statW, 0.78, {
      fontSize: 44, color: W, fontFace: 'Cambria', bold: true, align: 'center', valign: 'middle',
    })
    txt(s, st.label, cx + 0.12, cy + 0.92, statW - 0.24, 0.24, {
      fontSize: 7.5, color: ST, fontFace: 'Calibri', charSpacing: 1, align: 'center',
    })
  })

  // 3 "Why Gateway" cards
  const why = [
    { title: 'Local Market Expertise', body: 'Deep roots and relationships across the upper Midwest multifamily market.' },
    { title: 'Proven Results', body: 'Track record of maximizing value for clients through strategic positioning and targeted marketing.' },
    { title: 'Full-Service Platform', body: 'End-to-end transaction management from valuation and marketing to due diligence and closing.' },
  ]
  const dW = (13.3 - 0.76 - 0.18 * 2) / 3
  why.forEach((d, i) => {
    const cx = 0.38 + i * (dW + 0.18)
    const cy = 5.16
    box(s, cx, cy, dW, 1.84, W)
    box(s, cx, cy, dW, 0.048, G)
    txt(s, d.title, cx + 0.18, cy + 0.14, dW - 0.36, 0.3, {
      fontSize: 9, color: N, fontFace: 'Calibri', bold: true,
    })
    txt(s, d.body, cx + 0.18, cy + 0.5, dW - 0.36, 1.2, {
      fontSize: 9.5, color: CH, fontFace: 'Calibri', lineSpacing: 1.4,
    })
  })

  addFooter(s, '7', logoData)
}

function buildSlide10_BackCover(prs, agents, property, circleLogoData, logoData) {
  const s = prs.addSlide()
  box(s, 0, 0, 13.3, 7.5, N)

  // Circle logo
  if (circleLogoData) {
    s.addImage({ data: circleLogoData, x: (13.3 - 2.9) / 2, y: 0.28, w: 2.9, h: 2.9 })
  } else {
    // Fallback circle
    box(s, (13.3 - 2.9) / 2, 0.28, 2.9, 2.9, N2)
    txt(s, 'GRA', (13.3 - 2.9) / 2, 0.28, 2.9, 2.9, {
      fontSize: 48, color: G, fontFace: 'Cambria', bold: true, align: 'center', valign: 'middle',
    })
  }

  box(s, 0.8, 3.4, 11.7, 0.022, G)
  txt(s, 'EXCLUSIVELY OFFERED BY', 0, 3.5, 13.3, 0.3, {
    fontSize: 11, color: W, fontFace: 'Calibri', charSpacing: 5, align: 'center',
  })
  box(s, 0.8, 4.0, 11.7, 0.022, G)

  // 2 agent panels
  const panelW = 5.87
  const panels = [
    { x: 0.65, agent: agents[0] },
    { x: 6.75, agent: agents[1] },
  ]
  panels.forEach(({ x, agent }) => {
    if (!agent) return
    box(s, x, 4.14, panelW, 2.72, N2)
    box(s, x, 4.14, panelW, 0.048, G)
    txt(s, agent.name, x + 0.2, 4.22, panelW - 0.4, 0.42, {
      fontSize: 14, color: W, fontFace: 'Calibri', bold: true, charSpacing: 1.5, align: 'center',
    })
    txt(s, agent.title, x + 0.2, 4.64, panelW - 0.4, 0.3, {
      fontSize: 10, color: G, fontFace: 'Calibri', align: 'center',
    })
    box(s, x + 0.4, 4.98, panelW - 0.8, 0.018, ST)
    txt(s, 'Gateway Real Estate Advisors', x + 0.2, 5.04, panelW - 0.4, 0.28, {
      fontSize: 9, color: ST, fontFace: 'Calibri', align: 'center',
    })
    txt(s, agent.phone, x + 0.2, 5.36, panelW - 0.4, 0.38, {
      fontSize: 11, color: W, fontFace: 'Calibri', bold: true, align: 'center',
    })
    txt(s, agent.email, x + 0.2, 5.76, panelW - 0.4, 0.28, {
      fontSize: 9, color: ST, fontFace: 'Calibri', align: 'center',
    })
    txt(s, agent.lic, x + 0.2, 6.06, panelW - 0.4, 0.28, {
      fontSize: 8.5, color: GR, fontFace: 'Calibri', italic: true, align: 'center',
    })
  })

  // Gold vertical divider
  box(s, 6.65, 4.14, 0.04, 2.72, G)

  // Disclaimer
  txt(s, 'The information contained herein has been obtained from sources deemed reliable. While we do not doubt its accuracy, we have not verified it and make no guarantee, warranty or representation about it.',
    0.8, 6.9, 11.7, 0.28, {
      fontSize: 7, color: GR, fontFace: 'Calibri', align: 'center',
    })

  // Footer
  box(s, 0, 7.12, 13.3, 0.38, N3)
  if (logoData) {
    const h = 0.28, w = h * WORDMARK_RATIO
    s.addImage({ data: logoData, x: 0.24, y: 7.18, w, h })
  }
  txt(s, 'CONFIDENTIAL  ·  NOT FOR DISTRIBUTION', 4.5, 7.23, 4.3, 0.18, {
    fontSize: 6.5, color: GR, charSpacing: 1.5, fontFace: 'Calibri', align: 'center',
  })
  txt(s, '10/10', 13.3 - 0.4, 7.23, 0.28, 0.18, {
    fontSize: 7.5, color: G, fontFace: 'Cambria', align: 'right',
  })
}

// ─── Main Export ─────────────────────────────────────────────────────────────
export async function generateOM(property, agents, financials, market, photos) {
  const prs = new pptxgen()
  prs.layout = 'LAYOUT_WIDE'  // 13.3" × 7.5"
  prs.defineLayout({ name: 'GATEWAY_OM', width: 13.3, height: 7.5 })
  prs.layout = 'GATEWAY_OM'

  const logoData = photos.wordmarkLogo || null
  const circleLogoData = photos.circleLogo || null

  buildSlide1_Cover(prs, property, agents, photos, logoData)
  buildSlide2_TOC(prs, property, logoData)
  buildSlide3_ExecutiveSummary(prs, property, financials, logoData)
  buildSlide4_PropertyOverview(prs, property, logoData)
  buildSlide5_Financial(prs, financials, logoData)
  buildSlide6_Market(prs, property, market, logoData)
  buildSlide7_PhotoGallery(prs, photos, logoData)
  buildSlide8_Agents(prs, agents, property, logoData)
  buildSlide9_AboutGateway(prs, logoData)
  buildSlide10_BackCover(prs, agents, property, circleLogoData, logoData)

  const safeName = property.name.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_')
  await prs.writeFile({ fileName: `Gateway_${safeName}_OM.pptx` })
}

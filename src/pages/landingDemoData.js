/**
 * Sample data for the /lp/demo route — lets anyone preview the luxury property
 * landing page (and the whole landing kit) with no database or real mailing.
 * Images are royalty-free Unsplash photos loaded directly in the browser.
 */
const img = (id, q = 80, w = 1600) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=${q}`

const portrait = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=480&h=480&q=80`

export const DEMO_LISTING = {
  name: 'Demo — 14 Cliffside Terrace',
  // The first agent is the "creator" of the mailing; the second is a co-agent.
  agents: [
    {
      id: 'demo-a1',
      name: 'Daniel Hart',
      role: 'Principal Broker',
      phone: '+15125550147',
      email: 'daniel@gatewayrealestate.com',
      photo_url: portrait('photo-1560250097-0b93528c311a'),
      color: '#1e2642',
      bio: 'Daniel has guided more than $400M in luxury and waterfront transactions across the region. Known for discreet, data-driven advising, he pairs architectural fluency with a relentless negotiating edge — and a client roster built almost entirely on referrals.',
    },
    {
      id: 'demo-a2',
      name: 'Sophia Bennett',
      role: "Buyer's Advisor",
      phone: '+15125550162',
      email: 'sophia@gatewayrealestate.com',
      photo_url: portrait('photo-1573496359142-b8d87734a5a2'),
      color: '#7c3aed',
      bio: 'Sophia specializes in matching discerning buyers with one-of-a-kind homes. With a background in interior design, she sees what a property can become — and shepherds every detail from first showing to closing day.',
    },
  ],
  get agent() { return this.agents[0] },
  config: {
    accent: '#1e2642',
    headline: '14 Cliffside Terrace — A Modern Waterfront Estate',
    subheadline: 'Architecturally significant, walls of glass, and 180° lake views from nearly every room.',
    cta_text: 'Request a private showing',
    // Mirrors the PUBLIC shape of an attached OM (no storage path — the server
    // strips it) so /lp/demo shows the download gate as visitors see it. The
    // demo's unlock is simulated; nothing is signed or captured.
    om: { available: true, filename: 'Cliffside-Terrace-OM.pdf', title: 'Cliffside Terrace · Offering Memorandum', size: 4_600_000 },
    detail_mode: 'residential',
    price: '4750000',
    beds: '5',
    baths: '6',
    sqft: '7820',
    lot_size: '38000',
    year_built: '2021',
    description:
      'Set on a rare double waterfront lot, this Tom Kundig–inspired residence pairs board-formed concrete with warm white oak and floor-to-ceiling glass. A central courtyard, infinity-edge pool, and private boat dock complete a one-of-a-kind offering minutes from downtown.',
    features: [
      'Infinity-edge pool & spa',
      'Private deep-water boat dock',
      'Chef’s kitchen — Wolf & Sub-Zero',
      'Primary suite with lake terrace',
      'Glass-walled wine cellar',
      'Smart-home automation throughout',
      'Heated 4-car gallery garage',
      'Whole-home generator',
    ],
    images: [
      { url: img('photo-1600596542815-ffad4c1539a9'), caption: '' },
      { url: img('photo-1600585154340-be6161a56a0c'), caption: 'Great room' },
      { url: img('photo-1600607687939-ce8a6c25118c'), caption: 'Chef’s kitchen' },
      { url: img('photo-1600566753086-00f18fb6b3ea'), caption: 'Primary suite' },
      { url: img('photo-1600210492493-0946911123ea'), caption: 'Pool & terrace' },
      { url: img('photo-1605276374104-dee2a0ed3cd6'), caption: 'Dusk waterfront' },
    ],
  },
}

/**
 * Sample data for /lp/demo-portfolio — one QR code, several properties. Mirrors
 * the PUBLIC shape the server sends in teaser mode: each property's gated
 * numbers and storage paths are already gone (api/_lib/dealRoom.js).
 */
export const DEMO_PORTFOLIO = {
  name: 'Demo — Central Iowa Multifamily Portfolio',
  agents: DEMO_LISTING.agents,
  get agent() { return this.agents[0] },
  config: {
    accent: '#1e2642',
    eyebrow: 'Exclusive Portfolio Offering',
    asset_line: 'Multifamily · 3 Properties · 44 Units',
    headline: 'Central Iowa Multifamily Portfolio',
    location_line: 'Marshalltown · Ames · Newton',
    subheadline: 'Three stabilized, well-kept apartment properties offered together or separately.',
    description: 'A rare chance to add 44 units across three growing central Iowa markets. Each property is broken out below with its own photos, numbers and documents.',
    detail_mode: 'commercial',
    price_display: 'call_for_offers',
    deal_room: {
      available: true, teaser: true, doc_count: 5, update_count: 0, gated_photo_count: 3,
      gated_fields: ['cap_rate', 'noi', 'occupancy'],
      doc_titles: ['Portfolio Summary', 'Oak Street Apartments · Offering Memorandum', 'Oak Street Apartments · Rent Roll',
                   'Linden Court · Offering Memorandum', 'Elm Terrace · Offering Memorandum'],
    },
    portfolio: [
      {
        id: 'p-oak', name: 'Oak Street Apartments', asset_line: 'Multifamily · 20 Units', location_line: 'Marshalltown, IA',
        units: '20', building_sqft: '16400', year_built: '1984',
        description: 'Two-story garden-style buildings on a quiet block, with off-street parking and on-site laundry.',
        images: [
          { url: img('photo-1545324418-cc1a3fa10c00'), caption: '' },
          { url: img('photo-1502672260266-1c1ef2d93688'), caption: 'Typical unit' },
          { url: img('photo-1484154218962-a197022b5858'), caption: 'Kitchen' },
        ],
        om: { available: true, filename: 'Oak-Street-OM.pdf', title: 'Offering Memorandum', size: 23_300_000 },
        doc_titles: ['Offering Memorandum', 'Rent Roll'], gated_photo_count: 2,
      },
      {
        id: 'p-linden', name: 'Linden Court', asset_line: 'Multifamily · 16 Units', location_line: 'Ames, IA',
        units: '16', building_sqft: '12800', year_built: '1996',
        description: 'Walkable to campus, with steady student and young-professional demand.',
        images: [
          { url: img('photo-1460317442991-0ec209397118'), caption: '' },
          { url: img('photo-1493809842364-78817add7ffb'), caption: 'Living room' },
        ],
        om: { available: true, filename: 'Linden-Court-OM.pdf', title: 'Offering Memorandum', size: 18_100_000 },
        doc_titles: ['Offering Memorandum'], gated_photo_count: 1,
      },
      {
        id: 'p-elm', name: 'Elm Terrace', asset_line: 'Multifamily · 8 Units', location_line: 'Newton, IA',
        units: '8', year_built: '1972',
        description: 'A small, fully occupied building with long-tenured residents.',
        images: [{ url: img('photo-1512917774080-9991f1c4c750'), caption: '' }],
        om: { available: true, filename: 'Elm-Terrace-OM.pdf', title: 'Offering Memorandum', size: 9_800_000 },
        doc_titles: ['Offering Memorandum'], gated_photo_count: 0,
      },
    ],
  },
}

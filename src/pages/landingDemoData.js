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

// ── Demo payloads for the other landing templates ─────────────────────────────
// Each matches the { config, agents } preview contract of its page:
//   /lp/demo/valuation → LandingValuation, /lp/demo/multifamily →
//   LandingMultifamily, /lp/demo/agent → LandingAgent, /lp/demo/deal →
//   LandingDeal.

export const DEMO_VALUATION = {
  agents: DEMO_LISTING.agents.slice(0, 1),
  config: {
    accent: '#1e2642',
    headline: 'Find out what your home with a pool is worth today',
    subheadline:
      'Backyard pools are commanding a premium in this market. Get a private, broker-prepared valuation — real comps, not a software estimate.',
    cta_text: 'Get my free valuation',
    images: [{ url: img('photo-1564013799919-ab600027ffc6'), caption: 'Homes like yours are in demand' }],
    highlights: [
      { label: 'Homeowners served', value: '120+' },
      { label: 'Avg days to close', value: '18' },
      { label: 'Sold above ask',    value: '64%' },
    ],
  },
}

export const DEMO_MULTIFAMILY = {
  agents: DEMO_LISTING.agents.slice(0, 1),
  config: {
    accent: '#1e2642',
    headline: "What's your multifamily really worth in today's market?",
    subheadline:
      'Rates moved. Comps moved. Get a fresh cap-rate-driven number from a broker who actually closes deals in your submarket.',
    cta_text: 'Get my free valuation',
    images: [
      { url: img('photo-1545324418-cc1a3fa10c00'), units: '24 units',  price: 'Sold $6.2M' },
      { url: img('photo-1460317442991-0ec209397118'), units: '12 units', price: 'Sold $3.1M' },
      { url: img('photo-1512917774080-9991f1c4c750'), units: '8 units' },
    ],
    highlights: [
      { label: 'Closed volume',      value: '$240M+' },
      { label: 'Avg days on market', value: '38' },
      { label: 'Owners served',      value: '120+' },
    ],
  },
}

export const DEMO_AGENT_PAGE = {
  agents: DEMO_LISTING.agents.slice(0, 1),
  config: {
    accent: '#1e2642',
    headline: 'Every client gets my direct line — and my full attention.',
    subheadline:
      'From waterfront estates to first investments, I treat every transaction like my own. Most of my business comes from repeat clients and referrals — that only happens when people are taken care of.',
    cta_text: 'Work with Daniel',
    highlights: [
      { label: 'Career volume', value: '$400M+' },
      { label: 'Homes closed',  value: '310' },
      { label: 'Years',         value: '14' },
      { label: 'Referral rate', value: '92%' },
    ],
    listings: [
      { image: img('photo-1600596542815-ffad4c1539a9', 80, 900), title: '14 Cliffside Terrace',   price: '$4,750,000', status: 'For Sale' },
      { image: img('photo-1600585154340-be6161a56a0c', 80, 900), title: '228 Juniper Hollow',     price: '$1,395,000', status: 'In Escrow' },
      { image: img('photo-1600607687939-ce8a6c25118c', 80, 900), title: '9 Bluff View Court',     price: '$2,180,000', status: 'Just Sold' },
    ],
    socials: {
      instagram: 'https://instagram.com/gatewayreadvisors',
      linkedin:  'https://linkedin.com/company/gateway-real-estate-advisors',
      website:   'https://gatewayreadvisors.com',
    },
  },
}

export const DEMO_DEAL = {
  agents: DEMO_LISTING.agents.slice(0, 1),
  config: {
    accent: '#1e2642',
    headline: '32 units, two parcels, first offering in 40 years.',
    subheadline:
      'A generational multifamily asset in a supply-constrained submarket — being shared quietly with a short list of qualified buyers before any public marketing.',
    cta_text: 'Request the OM',
    images: [{ url: img('photo-1486406146926-c627a92ad1ab') }],
    reveal_photo: false,
    highlights: [
      { label: 'Units',        value: '32' },
      { label: 'Current cap',  value: '5.4%' },
      { label: 'Occupancy',    value: '97%' },
    ],
    teaser_points: [
      'Two contiguous parcels with existing upside through RUBS and unit turns.',
      'Average in-place rents ~18% below market comparables.',
      'Assumable financing available to qualified buyers.',
      'Full OM includes rent roll, T-12, and pricing guidance.',
    ],
  },
}

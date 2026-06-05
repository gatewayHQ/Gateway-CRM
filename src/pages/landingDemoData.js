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

// Mailing types, landing-page kinds, starter templates and status styles.

export const MAILING_TYPE_OPTS = [
  { value: 'postcard',    label: 'Postcard'    },
  { value: 'letter',      label: 'Letter'      },
  { value: 'flyer',       label: 'Flyer'       },
  { value: 'door-hanger', label: 'Door Hanger' },
  { value: 'other',       label: 'Other'       },
]

export const LANDING_OPTS = [
  { value: 'property',    label: 'Property Showcase',     icon: 'building',    sub: 'Hero photo + details of a property in your CRM. Best when you have a clean listing.' },
  { value: 'multifamily', label: 'Multifamily Valuation', icon: 'trending-up', sub: 'Dark, premium "what\'s your multifamily worth?" page. Bring your own photos + market stats.' },
  { value: 'valuation',   label: 'Home Valuation',        icon: 'dollar',      sub: 'Single-family / general "what\'s your home worth?" page. Captures seller leads.' },
  { value: 'mailing',     label: 'Mailing List',          icon: 'mail',        sub: 'Luxurious email-capture page. Grow your personal or team mailing list — dark/light, fully editable.' },
  { value: 'custom',      label: 'Custom URL',            icon: 'link',        sub: 'Redirect the QR to any URL you control — your own site, MLS, video, etc.' },
]

// Quick-start templates — pre-fill the form so an agent can spin up a mailing in 5 seconds
export const TEMPLATES = [
  {
    id:          'just-sold',
    label:       'Just Sold',
    description: 'Postcard to neighbors after a closing — drives valuation requests.',
    accent:      '#10b981',
    icon:        'check',
    fields: {
      name:         'Just Sold — [Address]',
      description:  'Sent to surrounding 200 homes after a closing.',
      mailing_type: 'postcard',
      landing_type: 'multifamily',
      landing_config: {
        headline:    'Your neighbor just sold. Curious what yours is worth?',
        subheadline: "We just closed nearby. Get the same cap-rate-driven analysis we used — no obligation, no sales pitch.",
        cta_text:    'See my valuation',
      },
    },
  },
  {
    id:          'just-listed',
    label:       'Just Listed',
    description: 'Drive showings + buyer leads for an active listing.',
    accent:      '#2563eb',
    icon:        'home',
    fields: {
      name:         'Just Listed — [Address]',
      description:  'Postcard drop to drive showings on a new listing.',
      mailing_type: 'postcard',
      landing_type: 'property',
    },
  },
  {
    id:          'multifamily-farm',
    label:       'Multifamily Farm',
    description: 'Targeted mailer to multifamily owners in a submarket.',
    accent:      '#c9a961',
    icon:        'trending-up',
    fields: {
      name:         'Multifamily Farm — [Submarket]',
      description:  'Quarterly touch to multifamily owners in our farm area.',
      mailing_type: 'postcard',
      landing_type: 'multifamily',
      landing_config: {
        headline:    "What's your multifamily really worth in today's market?",
        subheadline: "Rates moved. Comps moved. Get a fresh cap-rate-driven number from a broker who actually closes deals here.",
        cta_text:    'Get my free valuation',
        highlights: [
          { label: 'Closed in submarket', value: '$240M+' },
          { label: 'Avg days on market',  value: '38' },
          { label: 'Owners served',       value: '120+' },
        ],
      },
    },
  },
  {
    id:          'open-house',
    label:       'Open House',
    description: 'Drive foot traffic to a Saturday/Sunday open house.',
    accent:      '#7c3aed',
    icon:        'calendar',
    fields: {
      name:         'Open House — [Address]',
      description:  'Door hangers for the weekend before an open house.',
      mailing_type: 'door-hanger',
      landing_type: 'property',
    },
  },
]

export const STATUS_CONFIG = {
  draft:    { label: 'Draft',    bg: 'var(--gw-bone)',        color: 'var(--gw-mist)'  },
  active:   { label: 'Active',   bg: '#dbeafe',               color: '#1d4ed8'         },
  sent:     { label: 'Sent',     bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  archived: { label: 'Archived', bg: '#f3f4f6',               color: '#6b7280'         },
}

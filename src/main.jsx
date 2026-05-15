import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import LeadCapturePage from './pages/LeadCapture.jsx'
import PropertyLandingPage from './pages/PropertyLanding.jsx'
import CampaignLandingPage from './pages/CampaignLanding.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import './styles/app.css'

const pathname       = window.location.pathname
const isLeadPage     = pathname === '/lead'
const listingMatch   = pathname.match(/^\/listing\/([0-9a-f-]{36})/i)
const campaignMatch  = pathname.match(/^\/campaign\/([a-z0-9]{6,12})/i)

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    {listingMatch
      ? <PropertyLandingPage propertyId={listingMatch[1]} />
      : campaignMatch
        ? <CampaignLandingPage code={campaignMatch[1]} />
        : isLeadPage
          ? <LeadCapturePage />
          : <App />
    }
  </ErrorBoundary>
)

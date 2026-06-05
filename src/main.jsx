import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import LeadCapturePage from './pages/LeadCapture.jsx'
import PropertyLandingPage from './pages/PropertyLanding.jsx'
import LandingProperty from './pages/LandingProperty.jsx'
import LandingValuation from './pages/LandingValuation.jsx'
import LandingMultifamily from './pages/LandingMultifamily.jsx'
import { DEMO_LISTING } from './pages/landingDemoData.js'
import ClientPortal from './pages/ClientPortal.jsx'
import { initWebVitals } from './lib/perf.js'
import './styles/app.css'

initWebVitals()

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 12, fontFamily: 'DM Sans, sans-serif', padding: 24,
        }}>
          <div style={{ fontSize: 28, fontFamily: 'Cormorant Garamond, serif', fontWeight: 600, color: '#1e2642' }}>Gateway CRM</div>
          <div style={{ color: '#c0392b', background: '#fde8e6', border: '1px solid #f5c6c2', borderRadius: 6, padding: '12px 16px', maxWidth: 480, fontSize: 13 }}>
            <strong>Error:</strong> {this.state.error.message}
          </div>
          <div style={{ fontSize: 12, color: '#9aa3b2' }}>Check the browser console for details.</div>
        </div>
      )
    }
    return this.props.children
  }
}

const pathname = window.location.pathname
const isLeadPage     = pathname === '/lead'
const listingMatch   = pathname.match(/^\/listing\/([0-9a-f-]{36})/i)
const lpPropMatch    = pathname.match(/^\/lp\/property\/([0-9a-f-]{36})/i)
const lpValMatch     = pathname.match(/^\/lp\/valuation\/([0-9a-f-]{36})/i)
const lpMultiMatch   = pathname.match(/^\/lp\/multifamily\/([0-9a-f-]{36})/i)
const portalMatch    = pathname.match(/^\/portal\/([0-9a-f-]{36})/i)

const isDemoPage     = pathname === '/lp/demo'

let publicView = null
if (isDemoPage)          publicView = <LandingProperty preview={DEMO_LISTING} />
else if (listingMatch)   publicView = <PropertyLandingPage propertyId={listingMatch[1]} />
else if (lpPropMatch)    publicView = <LandingProperty   mailingId={lpPropMatch[1]} />
else if (lpValMatch)     publicView = <LandingValuation  mailingId={lpValMatch[1]} />
else if (lpMultiMatch)   publicView = <LandingMultifamily mailingId={lpMultiMatch[1]} />
else if (portalMatch)    publicView = <ClientPortal       token={portalMatch[1]} />
else if (isLeadPage)     publicView = <LeadCapturePage />

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    {publicView || <App />}
  </ErrorBoundary>
)

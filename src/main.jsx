import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import LeadCapturePage from './pages/LeadCapture.jsx'
import PropertyLandingPage from './pages/PropertyLanding.jsx'
import CampaignLandingPage from './pages/CampaignLanding.jsx'
import './styles/app.css'

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

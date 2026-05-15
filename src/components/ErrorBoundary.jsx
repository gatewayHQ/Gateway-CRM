import React from 'react'

function reportError(error, errorInfo) {
  // Log to server console (shows in Vercel function logs via console.error)
  console.error('[ErrorBoundary] Uncaught error:', error, errorInfo)

  // Persist last error in localStorage for the Settings page to display
  try {
    localStorage.setItem('gw_last_error', JSON.stringify({
      message: error?.message || String(error),
      stack: error?.stack || '',
      componentStack: errorInfo?.componentStack || '',
      timestamp: new Date().toISOString(),
    }))
  } catch {
    // localStorage may be unavailable in some environments — ignore
  }
}

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo })
    if (import.meta.env.PROD) {
      reportError(error, errorInfo)
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}>
          <div style={{
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
            padding: '40px 36px',
            maxWidth: 520,
            width: '100%',
            textAlign: 'center',
          }}>
            <div style={{
              fontFamily: 'Cormorant Garamond, Georgia, serif',
              fontSize: 28,
              fontWeight: 600,
              color: '#1e2642',
              marginBottom: 20,
            }}>
              Gateway CRM
            </div>

            <div style={{
              fontSize: 18,
              fontWeight: 700,
              color: '#1e293b',
              marginBottom: 12,
            }}>
              Something went wrong
            </div>

            <pre style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              padding: '12px 14px',
              fontSize: 12,
              color: '#64748b',
              textAlign: 'left',
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              marginBottom: 24,
              maxHeight: 160,
              overflowY: 'auto',
            }}>
              {this.state.error?.message || String(this.state.error)}
            </pre>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => window.location.reload()}
                style={{
                  background: '#1e2642',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 7,
                  padding: '9px 20px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Reload page
              </button>
              <button
                onClick={() => { window.location.href = '/' }}
                style={{
                  background: 'transparent',
                  color: '#1e2642',
                  border: '1px solid #cbd5e1',
                  borderRadius: 7,
                  padding: '9px 20px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Go to Dashboard
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary

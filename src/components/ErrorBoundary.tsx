import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }
  static getDerivedStateFromError(error: Error): State {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('AQ Observatory render failure', error, info)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="fatal-state">
        <AlertTriangle />
        <span className="eyebrow">Application recovery</span>
        <h1>Something went wrong</h1>
        <p>The dashboard encountered an unexpected rendering error. No logger or cloud data was changed.</p>
        <button className="button primary" onClick={() => window.location.reload()}>
          <RefreshCw size={16} /> Reload dashboard
        </button>
      </main>
    )
  }
}

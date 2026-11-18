import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Workspace error', error, info.componentStack) }
  render() {
    if (this.state.failed) return <main className="recovery-state" role="alert">
      <AlertCircle size={32} /><h1>The workspace couldn’t load</h1>
      <p>Reload to start a fresh session. Imported datasets remain stored on the server.</p>
      <button className="button primary" onClick={() => window.location.reload()}>Reload workspace</button>
    </main>
    return this.props.children
  }
}

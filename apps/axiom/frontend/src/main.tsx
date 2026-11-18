import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AxiomAuth } from './components/AxiomAuth'
import StaticHostSetup from './components/StaticHostSetup'
import { needsBackendSetup } from './deployment'
import './styles.css'
import './workspace.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{needsBackendSetup ? <StaticHostSetup /> : <AxiomAuth><App /></AxiomAuth>}</ErrorBoundary>
  </StrictMode>,
)

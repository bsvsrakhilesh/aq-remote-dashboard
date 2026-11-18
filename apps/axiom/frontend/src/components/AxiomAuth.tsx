import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { authClient } from '../auth-client'
import { privateWorkspaceUrl } from '../deployment'

export function AxiomAuth({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(!!authClient)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!authClient) return
    const { data: { subscription } } = authClient.auth.onAuthStateChange((_event, current) => {
      setSession(current)
      setLoading(false)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (!authClient) return children
  if (loading) return <main className="workspace-state" role="status">Checking your session…</main>

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!authClient) return
    const fields = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const result = await authClient.auth.signInWithPassword({
        email: String(fields.get('email') ?? ''),
        password: String(fields.get('password') ?? ''),
      })
      if (result.error) setError('Sign-in failed. Check your dashboard credentials and try again.')
    } catch {
      setError('Sign-in is temporarily unavailable.')
    } finally {
      setBusy(false)
    }
  }

  return session ? children : (
    <main className="workspace-state">
      <h1>Sign in to Axiom</h1>
      <p>Use your AQ Remote Dashboard account.</p>
      <form onSubmit={(event) => void signIn(event)}>
        <p><label>Email <input name="email" type="email" autoComplete="email" required /></label></p>
        <p><label>Password <input name="password" type="password" autoComplete="current-password" required /></label></p>
        <button className="button primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {privateWorkspaceUrl && <p><a href={privateWorkspaceUrl}>Open private workspace</a></p>}
    </main>
  )
}

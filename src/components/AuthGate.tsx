import { Activity, ArrowRight, LockKeyhole } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { demoMode, supabase } from '../services/supabase'

export function AuthGate({ children }: { children: ReactNode }) {
  const [session,setSession]=useState<Session|null>(null); const [loading,setLoading]=useState(!demoMode); const [email,setEmail]=useState(''); const [password,setPassword]=useState(''); const [error,setError]=useState(''); const [submitting,setSubmitting]=useState(false)
  useEffect(()=>{if(!supabase)return;void supabase.auth.getSession().then(({data})=>{setSession(data.session);setLoading(false)});const {data}=supabase.auth.onAuthStateChange((_event,next)=>setSession(next));return()=>data.subscription.unsubscribe()},[])
  if(demoMode)return children
  const submit=async(e:FormEvent)=>{e.preventDefault();if(!supabase)return;setSubmitting(true);setError('');const {error:authError}=await supabase.auth.signInWithPassword({email,password});if(authError)setError(authError.message);setSubmitting(false)}
  if(loading)return <div className="auth-loading"><Activity className="spin"/> Establishing secure session…</div>
  if(session)return children
  return <main className="login-page"><section className="login-story"><div className="brand light"><span className="brand-mark"><Activity size={20}/></span><span><strong>AQ Observatory</strong><small>Research network</small></span></div><div><span className="eyebrow">Environmental intelligence</span><h1>Field data,<br/>within reach.</h1><p>Secure remote visibility for research-grade air quality logger networks.</p></div><small>Full-resolution data stays on the logger. Always.</small></section><section className="login-form-wrap"><form className="login-card" onSubmit={submit}><span className="login-icon"><LockKeyhole/></span><span className="eyebrow">Authorised access</span><h2>Welcome back</h2><p>Sign in to monitor your logger network.</p><label>Email address<input type="email" required autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="researcher@institute.edu"/></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••••••"/></label>{error&&<div className="auth-error" role="alert">{error}</div>}<button className="button primary" disabled={submitting}>{submitting?'Signing in…':<>Continue <ArrowRight size={16}/></>}</button><small>Protected by Supabase Auth and row-level security.</small></form></section></main>
}

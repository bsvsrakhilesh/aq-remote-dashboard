import { createClient } from '@supabase/supabase-js'
import { apiUrl } from './deployment'

const authUrl = import.meta.env.VITE_SUPABASE_URL
const publicKey = import.meta.env.VITE_SUPABASE_ANON_KEY
export const authClient = authUrl && publicKey ? createClient(authUrl, publicKey) : null

export async function apiFetch(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers)
  if (authClient) {
    const { data } = await authClient.auth.getSession()
    if (data.session) headers.set('Authorization', `Bearer ${data.session.access_token}`)
  }
  return fetch(apiUrl(path), { ...options, headers })
}

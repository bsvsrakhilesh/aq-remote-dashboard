import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY
export const demoMode = import.meta.env.VITE_DEMO_MODE === 'true' || !url || !key
export const supabase = !demoMode ? createClient(url!, key!, { auth: { persistSession: true, autoRefreshToken: true } }) : null

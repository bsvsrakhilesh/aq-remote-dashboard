import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const adminClient = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
export async function authenticateDevice(request: Request) {
  const code = request.headers.get('x-device-id')
  const secret = request.headers.get('x-device-key')
  if (!code || !secret || secret.length < 24) return null
  const db = adminClient()
  const { data } = await db.rpc('verify_device_secret', { p_device_code: code, p_secret: secret }).single()
  return data ? { db, device: data as { id: string; device_code: string } } : null
}

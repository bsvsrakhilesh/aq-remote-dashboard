import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  if (request.method !== 'POST') return json(request, { ok: false, error: 'method_not_allowed' }, 405)
  const authorization = request.headers.get('authorization')
  if (!authorization) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
  })
  const {
    data: { user },
  } = await userClient.auth.getUser()
  if (!user) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as { device_id?: string } | null
  if (!body?.device_id) return json(request, { ok: false, error: 'invalid_device_id' }, 400)
  const { data: device } = await userClient.from('devices').select('id').eq('id', body.device_id).maybeSingle()
  if (!device) return json(request, { ok: false, error: 'device_not_found' }, 404)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: existing } = await admin
    .from('device_commands')
    .select('id,status')
    .eq('device_id', body.device_id)
    .eq('command_type', 'list_files')
    .in('status', ['queued', 'acknowledged', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing) return json(request, { ok: true, command_id: existing.id, status: existing.status, deduplicated: true })
  const { data: command, error } = await admin
    .from('device_commands')
    .insert({ device_id: body.device_id, command_type: 'list_files', payload: { requested_by: user.id } })
    .select('id,status')
    .single()
  return error
    ? json(request, { ok: false, error: 'command_failed' }, 500)
    : json(request, { ok: true, command_id: command.id, status: command.status })
})

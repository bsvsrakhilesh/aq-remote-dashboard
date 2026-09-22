import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  const authorization = request.headers.get('authorization')
  if (!authorization) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
  })
  const {
    data: { user },
  } = await userClient.auth.getUser()
  if (!user) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as { request_id?: string } | null
  if (!body?.request_id) return json(request, { ok: false, error: 'invalid_request_id' }, 400)
  const { data: download } = await userClient
    .from('download_requests')
    .select('id,status,storage_path')
    .eq('id', body.request_id)
    .eq('created_by', user.id)
    .maybeSingle()
  if (!download) return json(request, { ok: false, error: 'request_not_found' }, 404)
  if (['ready', 'expired', 'failed'].includes(download.status))
    return json(request, { ok: true, status: download.status, idempotent: true })
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  await admin
    .from('download_requests')
    .update({ status: 'expired', error_message: 'Cancelled by user', expires_at: new Date().toISOString() })
    .eq('id', download.id)
  await admin
    .from('device_commands')
    .update({ status: 'expired', error_message: 'Cancelled by user' })
    .eq('command_type', 'download_file')
    .in('status', ['queued', 'acknowledged', 'running'])
    .contains('payload', { request_id: download.id })
  if (download.storage_path) await admin.storage.from('temporary-downloads').remove([download.storage_path])
  return json(request, { ok: true, status: 'expired' })
})

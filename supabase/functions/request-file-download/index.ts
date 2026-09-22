import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  if (request.method !== 'POST') return json(request, { ok: false, error: 'method_not_allowed' }, 405)
  const authorization = request.headers.get('authorization')
  if (!authorization) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
  })
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as { device_id?: string; filename?: string } | null
  if (
    !body?.device_id ||
    !body.filename ||
    body.filename.length > 255 ||
    body.filename.includes('/') ||
    body.filename.includes('\\')
  )
    return json(request, { ok: false, error: 'invalid_request' }, 400)
  const { data: file } = await db
    .from('device_files')
    .select('id,size_bytes')
    .eq('device_id', body.device_id)
    .eq('filename', body.filename)
    .maybeSingle()
  if (!file) return json(request, { ok: false, error: 'file_not_found' }, 404)
  const { data: active } = await db
    .from('download_requests')
    .select('id,status')
    .eq('device_id', body.device_id)
    .eq('filename', body.filename)
    .eq('created_by', user.id)
    .in('status', ['queued', 'device_acknowledged', 'uploading', 'ready'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (active) return json(request, { ok: true, request_id: active.id, status: active.status, deduplicated: true })
  const { data: download, error: requestError } = await db
    .from('download_requests')
    .insert({ device_id: body.device_id, filename: body.filename, total_bytes: file.size_bytes, created_by: user.id })
    .select()
    .single()
  if (requestError) return json(request, { ok: false, error: 'request_failed' }, 400)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { error: commandError } = await admin.from('device_commands').insert({
    device_id: body.device_id,
    command_type: 'download_file',
    payload: { filename: body.filename, request_id: download.id },
  })
  if (commandError) {
    await admin
      .from('download_requests')
      .update({ status: 'failed', error_message: 'Could not queue device command' })
      .eq('id', download.id)
    return json(request, { ok: false, error: 'command_failed' }, 500)
  }
  return json(request, { ok: true, request_id: download.id, status: 'queued' })
})

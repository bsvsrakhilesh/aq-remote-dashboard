import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as { request_id?: string } | null
  if (!body?.request_id) return json(request, { ok: false, error: 'invalid_request_id' }, 400)
  const { data: download } = await auth.db
    .from('download_requests')
    .select('id,storage_path,status')
    .eq('id', body.request_id)
    .eq('device_id', auth.device.id)
    .maybeSingle()
  if (!download?.storage_path) return json(request, { ok: false, error: 'request_not_found' }, 404)
  if (download.status === 'ready') return json(request, { ok: true, status: 'ready', idempotent: true })
  if (download.status !== 'uploading') return json(request, { ok: false, error: 'invalid_state' }, 409)
  const now = new Date()
  const expires = new Date(now.getTime() + 15 * 60 * 1000).toISOString()
  const { error } = await auth.db
    .from('download_requests')
    .update({ status: 'ready', progress_percent: 100, completed_at: now.toISOString(), expires_at: expires })
    .eq('id', body.request_id)
    .eq('device_id', auth.device.id)
  if (!error)
    await auth.db
      .from('device_commands')
      .update({ status: 'completed', completed_at: now.toISOString() })
      .eq('device_id', auth.device.id)
      .eq('command_type', 'download_file')
      .contains('payload', { request_id: body.request_id })
  return error
    ? json(request, { ok: false, error: 'write_failed' }, 500)
    : json(request, { ok: true, status: 'ready', expires_at: expires })
})

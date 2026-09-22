import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as { request_id?: string; error?: string } | null
  if (!body?.request_id) return json(request, { ok: false, error: 'invalid_request_id' }, 400)
  const message =
    typeof body.error === 'string' && body.error.trim() ? body.error.trim().slice(0, 240) : 'Device transfer failed'
  const { data, error } = await auth.db
    .from('download_requests')
    .update({ status: 'failed', error_message: message })
    .eq('id', body.request_id)
    .eq('device_id', auth.device.id)
    .in('status', ['queued', 'device_acknowledged', 'uploading'])
    .select('id,storage_path')
    .maybeSingle()
  if (error) return json(request, { ok: false, error: 'write_failed' }, 500)
  if (!data) return json(request, { ok: false, error: 'request_not_found' }, 404)
  if (data.storage_path) await auth.db.storage.from('temporary-downloads').remove([data.storage_path])
  await auth.db
    .from('device_commands')
    .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: message })
    .eq('device_id', auth.device.id)
    .eq('command_type', 'download_file')
    .contains('payload', { request_id: body.request_id })
  return json(request, { ok: true, status: 'failed' })
})

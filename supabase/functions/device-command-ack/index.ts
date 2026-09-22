import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as { command_id?: string } | null
  if (!body?.command_id) return json(request, { ok: false, error: 'invalid_command_id' }, 400)
  const { data: command } = await auth.db
    .from('device_commands')
    .select('id,command_type,payload,status')
    .eq('id', body.command_id)
    .eq('device_id', auth.device.id)
    .maybeSingle()
  if (!command) return json(request, { ok: false, error: 'command_not_found' }, 404)
  if (command.status !== 'queued') return json(request, { ok: true, status: command.status, idempotent: true })
  const now = new Date().toISOString()
  const { error } = await auth.db
    .from('device_commands')
    .update({ status: 'acknowledged', acknowledged_at: now })
    .eq('id', command.id)
    .eq('status', 'queued')
  const payload = command.payload as { request_id?: string }
  if (!error && command.command_type === 'download_file' && payload.request_id)
    await auth.db
      .from('download_requests')
      .update({ status: 'device_acknowledged' })
      .eq('id', payload.request_id)
      .eq('device_id', auth.device.id)
      .eq('status', 'queued')
  return error
    ? json(request, { ok: false, error: 'write_failed' }, 500)
    : json(request, { ok: true, status: 'acknowledged' })
})

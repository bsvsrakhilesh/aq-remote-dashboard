import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const expiry = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
  const { data: expiredCommands, error: expiryError } = await auth.db
    .from('device_commands')
    .update({ status: 'expired', error_message: 'Command was not acknowledged within 6 hours' })
    .eq('device_id', auth.device.id)
    .eq('status', 'queued')
    .lt('created_at', expiry)
    .select('command_type,payload')
  if (expiryError) return json(request, { ok: false, error: 'command_expiry_failed' }, 500)
  const expiredRequestIds = (expiredCommands ?? []).flatMap((command) => {
    const payload = command.payload as { request_id?: unknown } | null
    return command.command_type === 'download_file' && typeof payload?.request_id === 'string'
      ? [payload.request_id]
      : []
  })
  if (expiredRequestIds.length) {
    const { error } = await auth.db
      .from('download_requests')
      .update({ status: 'expired', error_message: 'The logger did not start this transfer within 6 hours' })
      .in('id', expiredRequestIds)
      .eq('status', 'queued')
    if (error) return json(request, { ok: false, error: 'request_expiry_failed' }, 500)
  }
  const { data, error } = await auth.db
    .from('device_commands')
    .select('id,command_type,payload')
    .eq('device_id', auth.device.id)
    .eq('status', 'queued')
    .order('created_at')
    .limit(1)
    .maybeSingle()
  if (error) return json(request, { ok: false, error: 'read_failed' }, 500)
  return json(request, data ? { command_id: data.id, command: data.command_type, ...data.payload } : { command: null })
})

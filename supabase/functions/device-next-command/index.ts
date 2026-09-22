import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const expiry = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await auth.db
    .from('device_commands')
    .update({ status: 'expired', error_message: 'Command was not acknowledged within 30 minutes' })
    .eq('device_id', auth.device.id)
    .eq('status', 'queued')
    .lt('created_at', expiry)
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

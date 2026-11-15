import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as {
    command_id?: string
    status?: string
    error_message?: string
  } | null
  if (!body?.command_id) return json(request, { ok: false, error: 'invalid_command_id' }, 400)
  const status = body.status ?? 'acknowledged'
  if (!['acknowledged', 'running', 'completed', 'failed'].includes(status))
    return json(request, { ok: false, error: 'invalid_status' }, 400)
  const { data: command } = await auth.db
    .from('device_commands')
    .select('id,command_type,payload,status')
    .eq('id', body.command_id)
    .eq('device_id', auth.device.id)
    .maybeSingle()
  if (!command) return json(request, { ok: false, error: 'command_not_found' }, 404)
  if (
    (status === 'completed' && command.command_type !== 'list_files') ||
    (status === 'running' && command.command_type !== 'download_file')
  )
    return json(request, { ok: false, error: 'invalid_transition' }, 409)
  const priorStatuses = status === 'acknowledged' ? ['queued'] : ['queued', 'acknowledged', 'running']
  if (!priorStatuses.includes(command.status))
    return json(request, { ok: true, status: command.status, idempotent: true })
  const now = new Date().toISOString()
  const { data: updated, error } = await auth.db
    .from('device_commands')
    .update({
      status,
      ...(status === 'acknowledged' ? { acknowledged_at: now } : {}),
      ...(status === 'completed' || status === 'failed' ? { completed_at: now } : {}),
      ...(status === 'failed'
        ? { error_message: typeof body.error_message === 'string' ? body.error_message.trim().slice(0, 240) : null }
        : {}),
    })
    .eq('id', command.id)
    .in('status', priorStatuses)
    .select('id')
    .maybeSingle()
  const payload = command.payload as { request_id?: string }
  if (!error && updated && status === 'acknowledged' && command.command_type === 'download_file' && payload.request_id)
    await auth.db
      .from('download_requests')
      .update({ status: 'device_acknowledged' })
      .eq('id', payload.request_id)
      .eq('device_id', auth.device.id)
      .eq('status', 'queued')
  return error
    ? json(request, { ok: false, error: 'write_failed' }, 500)
    : json(request, { ok: true, status, idempotent: !updated })
})

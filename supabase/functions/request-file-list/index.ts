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
  const body = (await request.json().catch(() => null)) as {
    action?: string
    device_id?: string
    command_ids?: string[]
  } | null
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  if (body?.action === 'status') {
    const ids = body.command_ids
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 100 ||
      ids.some(
        (id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      )
    )
      return json(request, { ok: false, error: 'invalid_command_ids' }, 400)
    const { data: commands, error: statusError } = await admin
      .from('device_commands')
      .select('id,device_id,status,error_message,created_at,acknowledged_at')
      .eq('command_type', 'list_files')
      .in('id', ids)
    if (statusError) return json(request, { ok: false, error: 'status_read_failed' }, 500)
    const deviceIds = [...new Set((commands ?? []).map((command) => command.device_id))]
    const { data: visible, error: visibilityError } = deviceIds.length
      ? await userClient.from('devices').select('id').in('id', deviceIds)
      : { data: [], error: null }
    if (visibilityError) return json(request, { ok: false, error: 'device_read_failed' }, 500)
    const allowed = new Set((visible ?? []).map((device) => device.id))
    const accessible = (commands ?? []).filter((command) => allowed.has(command.device_id))
    const now = Date.now()
    const staleQueued = accessible
      .filter((command) => command.status === 'queued' && Date.parse(command.created_at) <= now - 6 * 60 * 60 * 1000)
      .map((command) => command.id)
    const staleAcknowledged = accessible
      .filter(
        (command) =>
          ['acknowledged', 'running'].includes(command.status) &&
          Date.parse(command.acknowledged_at ?? command.created_at) <= now - 30 * 60 * 1000,
      )
      .map((command) => command.id)
    const expired = new Set<string>()
    for (const [staleIds, statuses] of [
      [staleQueued, ['queued']],
      [staleAcknowledged, ['acknowledged', 'running']],
    ] as const) {
      if (!staleIds.length) continue
      const { data: updated, error: expireError } = await admin
        .from('device_commands')
        .update({
          status: 'expired',
          completed_at: new Date(now).toISOString(),
          error_message: 'File-list command timed out',
        })
        .eq('command_type', 'list_files')
        .in('id', staleIds)
        .in('status', statuses)
        .select('id')
      if (expireError) return json(request, { ok: false, error: 'command_expiry_failed' }, 500)
      for (const row of updated ?? []) expired.add(row.id)
    }
    const byId = new Map(accessible.map((command) => [command.id, command]))
    return json(request, {
      ok: true,
      statuses: ids.map((id) => {
        const command = byId.get(id)
        return {
          command_id: id,
          status: command ? (expired.has(id) ? 'expired' : command.status) : 'unknown',
          error_message: expired.has(id) ? 'File-list command timed out' : (command?.error_message ?? null),
        }
      }),
    })
  }
  if (!body?.device_id) return json(request, { ok: false, error: 'invalid_device_id' }, 400)
  const { data: device } = await userClient.from('devices').select('id').eq('id', body.device_id).maybeSingle()
  if (!device) return json(request, { ok: false, error: 'device_not_found' }, 404)
  const { data: existing, error: lookupError } = await admin
    .from('device_commands')
    .select('id,status,created_at,acknowledged_at')
    .eq('device_id', body.device_id)
    .eq('command_type', 'list_files')
    .in('status', ['queued', 'acknowledged', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lookupError) return json(request, { ok: false, error: 'command_lookup_failed' }, 500)
  if (existing) {
    // A failed scan used to leave an acknowledged command active forever.
    // Let a new request through once that scan has had ample time to finish.
    const activeSince =
      existing.status === 'queued' ? existing.created_at : (existing.acknowledged_at ?? existing.created_at)
    const timeoutMs = existing.status === 'queued' ? 6 * 60 * 60 * 1000 : 30 * 60 * 1000
    if (Date.parse(activeSince) > Date.now() - timeoutMs)
      return json(request, { ok: true, command_id: existing.id, status: existing.status, deduplicated: true })
    const { error: expireError } = await admin
      .from('device_commands')
      .update({
        status: 'expired',
        completed_at: new Date().toISOString(),
        error_message: 'File-list command timed out',
      })
      .eq('id', existing.id)
      .eq('status', existing.status)
    if (expireError) return json(request, { ok: false, error: 'command_expiry_failed' }, 500)
  }
  const { data: command, error } = await admin
    .from('device_commands')
    .insert({ device_id: body.device_id, command_type: 'list_files', payload: { requested_by: user.id } })
    .select('id,status')
    .single()
  return error
    ? json(request, { ok: false, error: 'command_failed' }, 500)
    : json(request, { ok: true, command_id: command.id, status: command.status })
})

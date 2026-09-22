import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as {
    request_id?: string
    bytes_uploaded?: number
    total_bytes?: number
  } | null
  if (
    !body?.request_id ||
    !Number.isSafeInteger(body.bytes_uploaded) ||
    !Number.isSafeInteger(body.total_bytes) ||
    body.bytes_uploaded! < 0 ||
    body.total_bytes! <= 0 ||
    body.bytes_uploaded! > body.total_bytes!
  )
    return json(request, { ok: false, error: 'invalid_progress' }, 400)
  const progress = Math.max(0, Math.min(99, Math.floor((body.bytes_uploaded / body.total_bytes) * 100)))
  const { data, error } = await auth.db
    .from('download_requests')
    .update({
      status: 'uploading',
      bytes_uploaded: body.bytes_uploaded,
      total_bytes: body.total_bytes,
      progress_percent: progress,
    })
    .eq('id', body.request_id)
    .eq('device_id', auth.device.id)
    .in('status', ['device_acknowledged', 'uploading'])
    .select('id')
    .maybeSingle()
  if (error) return json(request, { ok: false, error: 'write_failed' }, 500)
  return data
    ? json(request, { ok: true, progress_percent: progress })
    : json(request, { ok: false, error: 'request_not_found' }, 404)
})

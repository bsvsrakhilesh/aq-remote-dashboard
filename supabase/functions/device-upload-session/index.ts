import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as {
    request_id?: string
    filename?: string
    total_bytes?: number
  } | null
  if (!body?.request_id || !body.filename || !Number.isSafeInteger(body.total_bytes) || body.total_bytes! <= 0)
    return json(request, { ok: false, error: 'invalid_request' }, 400)
  const { data: download } = await auth.db
    .from('download_requests')
    .select('id,filename,status,total_bytes')
    .eq('id', body.request_id)
    .eq('device_id', auth.device.id)
    .maybeSingle()
  if (!download || download.filename !== body.filename)
    return json(request, { ok: false, error: 'request_not_found' }, 404)
  if (!['queued', 'device_acknowledged', 'uploading'].includes(download.status))
    return json(request, { ok: false, error: 'invalid_state' }, 409)
  if (download.total_bytes && Number(download.total_bytes) !== body.total_bytes)
    return json(request, { ok: false, error: 'size_mismatch' }, 409)
  const safe = body.filename.replace(/[^a-zA-Z0-9_.-]/g, '_')
  const path = `${auth.device.device_code}/${body.request_id}/${safe}`
  const { data, error } = await auth.db.storage.from('temporary-downloads').createSignedUploadUrl(path)
  if (error) return json(request, { ok: false, error: 'session_failed' }, 400)
  const { error: updateError } = await auth.db
    .from('download_requests')
    .update({
      status: 'uploading',
      storage_path: path,
      started_at: new Date().toISOString(),
      total_bytes: body.total_bytes,
    })
    .eq('id', body.request_id)
    .eq('device_id', auth.device.id)
  return updateError
    ? json(request, { ok: false, error: 'write_failed' }, 500)
    : json(request, { ok: true, path, token: data.token, signed_url: data.signedUrl })
})

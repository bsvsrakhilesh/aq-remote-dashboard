import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  if (request.method !== 'POST') return json(request, { ok: false, error: 'method_not_allowed' }, 405)
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as {
    request_id?: string
    filename?: string
    total_bytes?: number
    source_start_byte?: number
    source_end_byte?: number
    source_header_bytes?: number
  } | null
  if (
    !body?.request_id ||
    !body.filename ||
    !Number.isSafeInteger(body.total_bytes) ||
    body.total_bytes! <= 0 ||
    body.total_bytes! > 104857600
  )
    return json(request, { ok: false, error: 'invalid_request' }, 400)
  const { data: download } = await auth.db
    .from('download_requests')
    .select('id,filename,status,total_bytes,request_kind,source_start_byte')
    .eq('id', body.request_id)
    .eq('device_id', auth.device.id)
    .maybeSingle()
  if (!download || download.filename !== body.filename)
    return json(request, { ok: false, error: 'request_not_found' }, 404)
  if (!['queued', 'device_acknowledged', 'uploading'].includes(download.status))
    return json(request, { ok: false, error: 'invalid_state' }, 409)
  const automatic = download.request_kind === 'minute_history'
  if (automatic) {
    const start = body.source_start_byte
    const end = body.source_end_byte
    const header = body.source_header_bytes
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(header) ||
      start !== download.source_start_byte ||
      start! < 0 ||
      end! < start! ||
      end! > 4294967295 ||
      header! < 1 ||
      header! > 4096 ||
      body.total_bytes !== (start === 0 ? end : header! + end! - start!) ||
      body.total_bytes! < header!
    )
      return json(request, { ok: false, error: 'incremental_csv_required' }, 409)
  }
  // The active weekly CSV can grow after catalog listing. The authenticated
  // logger declares an immutable byte snapshot for this transfer.
  const safe = body.filename.replace(/[^a-zA-Z0-9_.-]/g, '_')
  const path = `${auth.device.device_code}/${body.request_id}/${safe}`
  const { data, error } = await auth.db.storage.from('temporary-downloads').createSignedUploadUrl(path)
  if (error) return json(request, { ok: false, error: 'session_failed' }, 400)
  const { data: updated, error: updateError } = await auth.db
    .from('download_requests')
    .update({
      status: 'uploading',
      storage_path: path,
      started_at: new Date().toISOString(),
      total_bytes: body.total_bytes,
      ...(automatic
        ? {
            source_end_byte: body.source_end_byte,
            source_header_bytes: body.source_header_bytes,
          }
        : {}),
    })
    .eq('id', body.request_id)
    .eq('device_id', auth.device.id)
    .in('status', ['queued', 'device_acknowledged', 'uploading'])
    .select('id')
    .maybeSingle()
  if (!updateError && !updated) return json(request, { ok: false, error: 'invalid_state' }, 409)
  return updateError
    ? json(request, { ok: false, error: 'write_failed' }, 500)
    : json(request, { ok: true, path, token: data.token, signed_url: data.signedUrl, upload_method: 'PUT' })
})

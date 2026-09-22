import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

interface CatalogFile {
  name: string
  size_bytes: number
  modified_at?: string | null
}
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as { files?: CatalogFile[]; command_id?: string } | null
  if (!Array.isArray(body?.files) || body.files.length > 5000)
    return json(request, { ok: false, error: 'invalid_files' }, 400)
  const valid = body.files.every(
    (file) =>
      typeof file.name === 'string' &&
      file.name.length > 0 &&
      file.name.length <= 255 &&
      Number.isSafeInteger(file.size_bytes) &&
      file.size_bytes >= 0 &&
      (!file.modified_at || !Number.isNaN(Date.parse(file.modified_at))),
  )
  if (!valid) return json(request, { ok: false, error: 'invalid_file_metadata' }, 400)
  const scannedAt = new Date().toISOString()
  const names = new Set(body.files.map((file) => file.name))
  const rows = body.files.map((file) => ({
    device_id: auth.device.id,
    filename: file.name,
    size_bytes: file.size_bytes,
    modified_at: file.modified_at ?? null,
    last_scanned_at: scannedAt,
  }))
  if (rows.length) {
    const { error } = await auth.db.from('device_files').upsert(rows, { onConflict: 'device_id,filename' })
    if (error) return json(request, { ok: false, error: 'write_failed' }, 500)
  }
  const { data: existing } = await auth.db.from('device_files').select('id,filename').eq('device_id', auth.device.id)
  const removed = (existing ?? []).filter((file) => !names.has(file.filename)).map((file) => file.id)
  if (removed.length) await auth.db.from('device_files').delete().in('id', removed)
  if (body.command_id)
    await auth.db
      .from('device_commands')
      .update({ status: 'completed', completed_at: scannedAt })
      .eq('id', body.command_id)
      .eq('device_id', auth.device.id)
      .eq('command_type', 'list_files')
  return json(request, { ok: true, count: rows.length, removed: removed.length })
})

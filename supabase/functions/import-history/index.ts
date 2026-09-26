import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { adminClient } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'
import { CsvMinuteAggregator } from '../_shared/csv-minute-history.ts'
import { csvFileWindow } from '../_shared/csv-file-window.ts'

const maxFile = 100 * 1024 * 1024
const maxChunk = 3 * 1024 * 1024

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed' }, 405)
  const authorization = request.headers.get('authorization')
  if (!authorization) return json(request, { error: 'Sign in to import a CSV.' }, 401)
  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
  })
  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) return json(request, { error: 'Sign in to import a CSV.' }, 401)
  const db = adminClient(),
    url = new URL(request.url)
  const action = url.searchParams.get('action')
  try {
    if (action === 'start') {
      const deviceId = url.searchParams.get('device_id'),
        filename = url.searchParams.get('filename')
      const size = Number(url.searchParams.get('bytes'))
      if (!deviceId || !filename || filename.length > 255 || !Number.isSafeInteger(size) || size < 1 || size > maxFile)
        throw new Error('Choose a CSV no larger than 100 MiB.')
      const { data: device } = await db.from('devices').select('id,device_code').eq('id', deviceId).maybeSingle()
      if (!device) return json(request, { error: 'Logger not found.' }, 404)
      csvFileWindow(filename, device.device_code)
      const { count, error: limitError } = await db
        .from('csv_import_runs')
        .select('id', { count: 'exact', head: true })
        .eq('created_by', user.id)
        .gte('created_at', new Date(Date.now() - 60000).toISOString())
      if (limitError) return json(request, { error: 'Import service unavailable.' }, 503)
      if ((count ?? 0) >= 3) return json(request, { error: 'Please wait a minute before another import.' }, 429)
      const { data: run, error } = await db
        .from('csv_import_runs')
        .insert({ device_id: deviceId, filename, expected_bytes: size, created_by: user.id })
        .select('id')
        .single()
      if (error || !run) throw new Error('Could not start the import.')
      return json(request, { ok: true, run_id: run.id })
    }
    const runId = url.searchParams.get('run_id')
    if (!runId) throw new Error('Import session is missing.')
    const { data: run } = await db
      .from('csv_import_runs')
      .select('id,device_id,filename,created_by,status,next_chunk,source_bytes,expected_bytes')
      .eq('id', runId)
      .maybeSingle()
    if (!run || run.created_by !== user.id) return json(request, { error: 'Import session not found.' }, 404)
    if (run.status !== 'processing') throw new Error('This import is already closed.')
    if (action === 'finish') {
      if (run.next_chunk < 1 || Math.abs(Number(run.source_bytes) - Number(run.expected_bytes)) > 1)
        throw new Error('The uploaded CSV is incomplete. Finish sending its remaining chunks.')
      const { error } = await db
        .from('csv_import_runs')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', run.id)
        .eq('status', 'processing')
      if (error) throw new Error('Could not confirm the import. Retry finishing.')
      const { data: finished } = await db
        .from('csv_import_runs')
        .select('imported_minutes,skipped_rows,source_bytes')
        .eq('id', run.id)
        .single()
      return json(request, {
        ok: true,
        minutes: finished?.imported_minutes ?? 0,
        skipped: finished?.skipped_rows ?? 0,
        bytes: finished?.source_bytes ?? 0,
      })
    }
    if (action !== 'chunk' || !request.body) throw new Error('Unknown import action.')
    const index = Number(url.searchParams.get('index')),
      originalBytes = Number(url.searchParams.get('original_bytes'))
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !Number.isSafeInteger(originalBytes) ||
      originalBytes < 1 ||
      originalBytes > maxChunk
    )
      throw new Error('Invalid import chunk number or size.')
    if (index < run.next_chunk) return json(request, { ok: true, duplicate: true, next_chunk: run.next_chunk })
    if (index !== run.next_chunk) return json(request, { error: 'Chunks must be sent in order.' }, 409)
    const { data: device } = await db
      .from('devices')
      .select('id,device_code,co2_enabled')
      .eq('id', run.device_id)
      .single()
    if (!device) throw new Error('Logger not found.')
    const { from, until } = csvFileWindow(run.filename, device.device_code)
    const parser = new CsvMinuteAggregator(from, until, device.co2_enabled)
    const reader = request.body.getReader(),
      decoder = new TextDecoder()
    let bytes = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxChunk) {
        await reader.cancel()
        throw new Error('CSV chunk exceeds 3 MiB.')
      }
      parser.push(decoder.decode(value, { stream: true }))
    }
    parser.push(decoder.decode())
    if (originalBytes > bytes || bytes - originalBytes > 4096) throw new Error('CSV chunk byte count is inconsistent.')
    const minutes = parser.finish()
    for (let offset = 0; offset < minutes.length; offset += 500) {
      const { error } = await db.rpc('ingest_minute_history', {
        p_device_id: device.id,
        p_rows: minutes.slice(offset, offset + 500),
      })
      if (error) throw new Error('Could not save averages. Retry this chunk safely.')
    }
    const { data: next, error } = await db.rpc('record_csv_import_chunk', {
      p_run: run.id,
      p_index: index,
      p_minutes: minutes.length,
      p_skipped: parser.skippedRows + parser.duplicateRows,
      p_bytes: originalBytes,
    })
    if (error) throw new Error('Could not confirm this chunk. Retry it safely.')
    return json(request, { ok: true, next_chunk: next, minutes: minutes.length })
  } catch (error) {
    const message =
      error instanceof Error && !/https?:|token|secret/i.test(error.message)
        ? error.message.slice(0, 200)
        : 'Import failed. Retry safely.'
    return json(request, { error: message }, 400)
  }
})

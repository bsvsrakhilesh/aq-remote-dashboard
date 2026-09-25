import { adminClient } from '../_shared/device-auth.ts'
import { CsvMinuteAggregator } from '../_shared/csv-minute-history.ts'

interface Job {
  id: string
  lease_token: string
  device_id: string
  filename: string
  hour_end: string
  storage_path: string
  download_request_id: string
  co2_enabled: boolean
  attempts: number
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  const secret = request.headers.get('x-history-secret')
  if (!secret) return new Response('unauthorized', { status: 401 })
  const db = adminClient()
  const { data: allowed, error: authError } = await db.rpc('authorize_csv_history_worker', { p_secret: secret })
  if (authError || allowed !== true) return new Response('unauthorized', { status: 401 })
  const { data, error: claimError } = await db.rpc('claim_csv_history_job')
  if (claimError) return Response.json({ error: 'claim_failed' }, { status: 503 })
  if (!data) return Response.json({ ok: true, idle: true })
  const job = data as Job
  try {
    const date = /_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})\.csv$/.exec(job.filename)
    if (!date) throw new Error('Unsupported weekly filename')
    const from = Date.parse(`${date[1]}T00:00:00+05:30`)
    const until = Math.min(Date.parse(job.hour_end), Date.parse(`${date[2]}T00:00:00+05:30`) + 86400000)
    const parser = new CsvMinuteAggregator(from, until, job.co2_enabled)
    const { data: signed, error: signError } = await db.storage
      .from('temporary-downloads')
      .createSignedUrl(job.storage_path, 180)
    if (signError || !signed) throw new Error('Temporary CSV is unavailable; a fresh transfer is needed')
    const response = await fetch(signed.signedUrl, { signal: AbortSignal.timeout(90000) })
    if (!response.ok || !response.body) throw new Error('Could not read the temporary CSV')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 104857600) {
        await reader.cancel()
        throw new Error('CSV exceeds the 100 MiB transfer limit')
      }
      parser.push(decoder.decode(value, { stream: true }))
    }
    parser.push(decoder.decode())
    const minutes = parser.finish()
    for (let offset = 0; offset < minutes.length; offset += 500) {
      const { error } = await db.rpc('ingest_minute_history', {
        p_device_id: job.device_id,
        p_rows: minutes.slice(offset, offset + 500),
      })
      if (error) throw new Error('Could not save minute averages; the import will retry')
    }
    const { data: finished, error: finishError } = await db.rpc('finish_csv_history_job', {
      p_job: job.id,
      p_token: job.lease_token,
      p_latest: minutes.at(-1)?.timestamp ?? null,
      p_minutes: minutes.length,
      p_skipped: parser.skippedRows + parser.duplicateRows,
      p_bytes: bytes,
    })
    if (finishError || !finished) throw new Error('Could not confirm the completed import')
    // Only remove the worker's own temporary copy after its averages are committed.
    const { error: removeError } = await db.storage.from('temporary-downloads').remove([job.storage_path])
    if (!removeError)
      await db
        .from('download_requests')
        .update({ status: 'expired', storage_path: null })
        .eq('id', job.download_request_id)
        .eq('request_kind', 'minute_history')
    return Response.json({ ok: true, minutes: minutes.length, skipped: parser.skippedRows + parser.duplicateRows })
  } catch (error) {
    const message =
      error instanceof Error && !/https?:|token|secret/i.test(error.message)
        ? error.message.slice(0, 180)
        : 'CSV processing failed; the import will retry'
    await db
      .from('csv_history_jobs')
      .update({
        status: job.attempts < 3 ? 'queued' : 'failed',
        retry_at: new Date(Date.now() + 15 * 60000).toISOString(),
        error_message: message,
        lease_until: null,
      })
      .eq('id', job.id)
      .eq('lease_token', job.lease_token)
      .eq('status', 'processing')
    await db
      .from('download_requests')
      .update({ status: 'failed', error_message: message })
      .eq('id', job.download_request_id)
      .eq('request_kind', 'minute_history')
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
})

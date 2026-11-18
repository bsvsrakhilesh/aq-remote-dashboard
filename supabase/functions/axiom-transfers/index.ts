import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { timingSafeEqual } from 'node:crypto'
import { adminClient } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const encode = (value: string) => new TextEncoder().encode(value)

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) })
  const fail = (error: string, status: number) => json(request, { error }, status)
  if (request.method !== 'POST') return fail('method_not_allowed', 405)

  const owner = Deno.env.get('AXIOM_OWNER_ID')
  const workerSecret = Deno.env.get('AXIOM_WORKER_SECRET')
  if (!uuid(owner) || !workerSecret || workerSecret.length < 32) return fail('not_configured', 503)
  const body = await request.json().catch(() => null)
  if (!body || typeof body.action !== 'string') return fail('invalid_request', 400)
  const authorization = request.headers.get('authorization') ?? ''
  const db = adminClient()

  if (['claim', 'renew', 'payload', 'finish', 'recover'].includes(body.action)) {
    const expected = encode(`Bearer ${workerSecret}`)
    const supplied = encode(authorization)
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return fail('unauthorized', 401)
    if (body.action === 'claim') {
      if (Deno.env.get('AXIOM_PAUSED') === 'true') return json(request, { job: null })
      const { data, error } = await db.rpc('claim_axiom_job', { p_owner: owner })
      if (error) return fail('queue_unavailable', 503)
      if (!data) return json(request, { job: null })
      const { storage_path, expires_at, ...job } = data
      if (storage_path) {
        const ttl = Math.min(300, Math.floor((Date.parse(expires_at) - Date.now()) / 1000))
        const { data: signed } =
          ttl > 0 ? await db.storage.from('temporary-downloads').createSignedUrl(storage_path, ttl) : { data: null }
        return json(request, { job: { ...job, url: signed?.signedUrl ?? null } })
      }
      return json(request, { job })
    }
    if (!uuid(body.id)) return fail('invalid_request', 400)
    const checksum = typeof body.checksum === 'string' && /^[0-9a-f]{64}$/.test(body.checksum) ? body.checksum : null
    if (body.action === 'recover') {
      if (!checksum) return fail('invalid_request', 400)
      const { data, error } = await db.rpc('recover_axiom_job', {
        p_owner: owner,
        p_job: body.id,
        p_checksum: checksum,
      })
      return error ? fail('queue_unavailable', 503) : json(request, { status: data })
    }
    if (!uuid(body.lease)) return fail('invalid_request', 400)
    if (body.action === 'renew' || body.action === 'payload') {
      const active = () => db.from('axiom_jobs')
      const now = new Date().toISOString()
      if (body.action === 'payload') {
        const { data, error } = await active()
          .select('payload')
          .eq('kind', 'minute')
          .eq('id', body.id)
          .eq('owner_id', owner)
          .eq('lease_id', body.lease)
          .eq('status', 'transferring')
          .gt('lease_until', now)
          .maybeSingle()
        if (error) return fail('queue_unavailable', 503)
        if (!data?.payload) return fail('lease_lost', 409)
        return new Response(data.payload, {
          headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      const { data, error } = await active()
        .update({ lease_until: new Date(Date.now() + 600_000).toISOString() })
        .eq('id', body.id)
        .eq('owner_id', owner)
        .eq('lease_id', body.lease)
        .eq('status', 'transferring')
        .gt('lease_until', now)
        .select('id')
        .maybeSingle()
      return error ? fail('queue_unavailable', 503) : data ? json(request, { ok: true }) : fail('lease_lost', 409)
    }
    const failure = ['source_unavailable', 'checksum_mismatch', 'archive_full', 'invalid_source'].includes(body.code)
      ? body.code
      : null
    if (!checksum && !failure) return fail('invalid_request', 400)
    const { data, error } = await db.rpc('finish_axiom_job', {
      p_owner: owner,
      p_job: body.id,
      p_lease: body.lease,
      p_checksum: checksum,
      p_error: checksum ? null : failure,
      p_retry: !checksum && body.retry === true,
    })
    return error ? fail('queue_unavailable', 503) : data ? json(request, { ok: true }) : fail('lease_lost', 409)
  }

  const auth = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  })
  const {
    data: { user },
  } = await auth.auth.getUser()
  if (!user) return fail('unauthorized', 401)
  if (user.id !== owner) return fail('forbidden', 403)

  if (body.action === 'pause' || body.action === 'resume') {
    const { error } = await db.from('axiom_worker_status').upsert({ owner_id: owner, paused: body.action === 'pause' })
    return error ? fail('queue_unavailable', 503) : json(request, { ok: true })
  }
  if (body.action === 'list') {
    const month = new Date().toISOString().slice(0, 7) + '-01'
    const [jobs, usage, worker] = await Promise.all([
      db
        .from('axiom_jobs')
        .select('id,filename,kind,device_id,status,created_at,finished_at,source_bytes,row_count,error_code')
        .eq('owner_id', owner)
        .order('created_at', { ascending: false })
        .limit(30),
      db.from('axiom_usage').select('reserved_bytes').eq('period', month).maybeSingle(),
      db.from('axiom_worker_status').select('last_seen_at,paused').eq('owner_id', owner).maybeSingle(),
    ])
    return jobs.error || usage.error || worker.error
      ? fail('queue_unavailable', 503)
      : json(request, {
          jobs: jobs.data,
          bytes: usage.data?.reserved_bytes ?? 0,
          limit: 1073741824,
          worker_last_seen: worker.data?.last_seen_at ?? null,
          paused: worker.data?.paused ?? false,
          locked: Deno.env.get('AXIOM_PAUSED') === 'true',
        })
  }
  if (body.action !== 'create' && body.action !== 'preview') return fail('invalid_request', 400)
  if (body.action === 'create' && Deno.env.get('AXIOM_PAUSED') === 'true') return fail('paused', 503)
  if (!uuid(body.device_id)) return fail('invalid_request', 400)
  const raw = body.action === 'create' && body.kind === 'raw' && uuid(body.file_id)
  const minute = body.kind === 'minute' && date(body.from) && date(body.through)
  if (!raw && !minute) return fail('invalid_request', 400)
  const { data, error } = await db.rpc('create_axiom_job', {
    p_owner: owner,
    p_device: body.device_id,
    p_kind: raw ? 'raw' : 'minute',
    p_file: raw ? body.file_id : null,
    p_from: minute ? body.from : null,
    p_through: minute ? body.through : null,
    p_preview: body.action === 'preview',
  })
  if (error)
    return fail(error.code === '22008' ? 'invalid_range' : 'queue_unavailable', error.code === '22008' ? 400 : 503)
  return data?.error ? fail(data.error, data.error === 'budget' ? 429 : 409) : json(request, data)
})
